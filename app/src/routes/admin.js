'use strict';
/** Administration : comptes, alertes, règles de détection, journal, sauvegardes, tableaux de bord, exports. */
const cryptoSvc = require('../security/crypto');
const password = require('../security/password');
const audit = require('../security/audit');
const anomaly = require('../security/anomaly');
const backup = require('../services/backup');
const { ROLES } = require('../security/rbac');
const { HttpError } = require('../lib/http');

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };

/** Déchiffre pour l'affichage les valeurs sensibles présentes dans le détail d'une entrée du journal. */
function revealDetails(d) {
  const out = { ...d };
  for (const k of ['valeur', 'avant', 'apres', 'commentaire']) {
    if (typeof out[k] === 'string' && out[k].startsWith('v1:')) {
      try { out[k] = cryptoSvc.decrypt(out[k]); } catch { out[k] = '(indéchiffrable)'; }
    }
  }
  return out;
}

module.exports = function adminRoutes(router, app) {
  const { db } = app;
  const startedAt = Date.now();
  let lastIntegrity = null;
  app.setIntegrity = (r) => { lastIntegrity = { ...r, verifie_le: new Date().toISOString() }; };

  router.get('/api/sante', async () => {
    await db.query('SELECT 1');
    return { statut: 'ok', base_de_donnees: 'ok', demarre_depuis_s: Math.round((Date.now() - startedAt) / 1000) };
  });

  router.get('/api/ref', app.requireAuth, async () => {
    const g = await db.query('SELECT id, code, libelle FROM groupes ORDER BY code');
    const m = await db.query('SELECT id, code, intitule FROM modules ORDER BY code');
    return { groupes: g.rows, modules: m.rows };
  });

  // ---------------- Journal d'audit
  router.get('/api/journal', app.requirePerm('journal.lire_complet', 'journal.lire_partiel'), async (ctx) => {
    const complet = app.can(ctx, 'journal.lire_complet');
    const voitNotes = app.can(ctx, 'note.lire_toutes');   // journal partiel du gestionnaire : absences uniquement
    const page = Math.max(0, parseInt(ctx.query.page, 10) || 0);
    const action = String(ctx.query.action || '').slice(0, 40);
    const acteur = String(ctx.query.acteur || '').slice(0, 40);
    const r = await db.query(
      `SELECT * FROM journal_audit
        WHERE ($1::boolean OR action LIKE 'absence.%' OR ($5::boolean AND (action LIKE 'note.%' OR action LIKE 'seance.%' OR action LIKE 'export.%')))
          AND ($2 = '' OR action LIKE $2 || '%') AND ($3 = '' OR acteur_login ILIKE '%' || $3 || '%')
        ORDER BY id DESC LIMIT 50 OFFSET $4`, [complet, action, acteur, page * 50, voitNotes]);
    const total = await db.query(
      `SELECT count(*)::int n FROM journal_audit WHERE ($1::boolean OR action LIKE 'absence.%' OR ($4::boolean AND (action LIKE 'note.%' OR action LIKE 'seance.%' OR action LIKE 'export.%')))
        AND ($2 = '' OR action LIKE $2 || '%') AND ($3 = '' OR acteur_login ILIKE '%' || $3 || '%')`, [complet, action, acteur, voitNotes]);
    await app.log(ctx, 'journal.consultation', null, { perimetre: complet ? 'complet' : 'partiel', page });
    return { perimetre: complet ? 'complet' : 'partiel', total: total.rows[0].n, page, entrees: r.rows.map((e) => ({ ...e, details: revealDetails(e.details) })) };
  });

  router.post('/api/journal/verifier', app.requirePerm('journal.verifier'), async (ctx) => {
    const res = await audit.verifyChain(db);
    app.setIntegrity(res);
    await app.log(ctx, 'journal.verification', null, { integre: res.integre, entrees: res.entrees, rupture: res.rupture });
    if (!res.integre) await anomaly.periodicIntegrityCheck();
    return res;
  });

  router.get('/api/admin/journal-technique', app.requirePerm('journal.lire_complet'), async () => {
    const r = await db.query('SELECT * FROM journal_technique ORDER BY id DESC LIMIT 50');
    return r.rows;
  });

  // ---------------- Alertes
  router.get('/api/alertes', app.requirePerm('alertes.gerer'), async (ctx) => {
    const sev = String(ctx.query.severite || ''); const st = String(ctx.query.statut || '');
    const r = await db.query(
      `SELECT a.*, u.login, u.nom_complet, u.role, t.nom_complet AS traitee_par_nom FROM alertes a
         LEFT JOIN utilisateurs u ON u.id=a.utilisateur_id LEFT JOIN utilisateurs t ON t.id=a.traitee_par
        WHERE ($1 = '' OR a.severite=$1) AND ($2 = '' OR a.statut=$2) ORDER BY a.id DESC LIMIT 100`, [sev, st]);
    return r.rows;
  });

  router.post('/api/alertes/:id', app.requirePerm('alertes.gerer'), async (ctx) => {
    const id = int(ctx.params.id); const statut = ctx.body.statut;
    const commentaire = String(ctx.body.commentaire || '').trim().slice(0, 300);
    if (!['confirmee', 'infirmee'].includes(statut)) throw new HttpError(400, 'Statut invalide.');
    const a = (await db.query('SELECT * FROM alertes WHERE id=$1', [id])).rows[0];
    if (!a) throw new HttpError(404, 'Alerte introuvable.');
    await db.query('UPDATE alertes SET statut=$2, commentaire=$3, traitee_par=$4, traitee_le=now() WHERE id=$1', [id, statut, commentaire || null, ctx.user.id]);
    await app.log(ctx, 'alerte.qualification', `alerte:${id}`, { statut, regle: a.regle });
    if (statut === 'confirmee' && ctx.body.suspendre && a.utilisateur_id && a.utilisateur_id !== ctx.user.id) {
      await db.query('UPDATE utilisateurs SET statut=\'suspendu\' WHERE id=$1', [a.utilisateur_id]);
      await db.query('UPDATE sessions SET revoquee=true WHERE utilisateur_id=$1', [a.utilisateur_id]);
      await app.log(ctx, 'compte.suspension', `utilisateur:${a.utilisateur_id}`, { motif: `alerte n° ${id} confirmée` });
    }
    return { ok: true };
  });

  // ---------------- Règles de détection
  router.get('/api/admin/regles', app.requirePerm('regles.configurer'), async () => {
    const r = await db.query('SELECT * FROM regles_detection ORDER BY code');
    return r.rows;
  });
  router.put('/api/admin/regles/:code', app.requirePerm('regles.configurer'), async (ctx) => {
    const ex = (await db.query('SELECT * FROM regles_detection WHERE code=$1', [ctx.params.code])).rows[0];
    if (!ex) throw new HttpError(404, 'Règle introuvable.');
    const p = { ...ex.parametres };
    for (const [k, v] of Object.entries(ctx.body.parametres || {})) {
      if (!(k in p)) continue;
      if (typeof p[k] === 'number') { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 10000) throw new HttpError(400, `Paramètre « ${k} » invalide.`); p[k] = n; }
      else if (typeof p[k] === 'string') { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new HttpError(400, `Heure « ${k} » invalide (HH:MM).`); p[k] = String(v); }
    }
    const active = ctx.body.active === undefined ? ex.active : !!ctx.body.active;
    const sev = ['information', 'avertissement', 'critique'].includes(ctx.body.severite) ? ctx.body.severite : ex.severite;
    await db.query('UPDATE regles_detection SET parametres=$2, active=$3, severite=$4 WHERE code=$1', [ex.code, p, active, sev]);
    anomaly.invalidate();
    await app.log(ctx, 'regle.modification', `regle:${ex.code}`, { avant: { ...ex.parametres, active: ex.active, severite: ex.severite }, apres: { ...p, active, severite: sev } });
    return { ok: true };
  });

  // ---------------- Comptes utilisateurs (cycle de vie des identités)
  router.get('/api/admin/utilisateurs', app.requirePerm('comptes.gerer'), async () => {
    const r = await db.query(
      `SELECT u.id, u.login, u.nom_complet, u.email, u.role, u.statut, u.mfa_active, u.echecs_consecutifs, u.verrouille_jusqua, u.derniere_connexion,
              u.mdp_change_le, u.doit_changer_mdp, u.cree_le, (u.verrouille_jusqua IS NOT NULL AND u.verrouille_jusqua > now()) AS verrouille,
              CASE u.role
                WHEN 'stagiaire' THEN (SELECT s.prenom || ' ' || s.nom || ' — CEF ' || s.cef || ' — ' || g.code
                                         FROM stagiaires s JOIN groupes g ON g.id = s.groupe_id WHERE s.utilisateur_id = u.id)
                WHEN 'parent' THEN (SELECT string_agg(s.prenom || ' ' || s.nom || ' (' || g.code || ')', ', ' ORDER BY s.nom)
                                      FROM parents_stagiaires ps JOIN stagiaires s ON s.id = ps.stagiaire_id JOIN groupes g ON g.id = s.groupe_id
                                     WHERE ps.parent_id = u.id)
              END AS rattachement
         FROM utilisateurs u
        ORDER BY array_position(ARRAY['administrateur','directeur','gestionnaire','formateur','stagiaire','parent'], u.role), u.login`);
    return r.rows;
  });

  router.post('/api/admin/utilisateurs', app.requirePerm('comptes.gerer'), async (ctx) => {
    const login = String(ctx.body.login || '').trim().toLowerCase();
    const nom = String(ctx.body.nom_complet || '').trim().slice(0, 80);
    const role = ctx.body.role; const tmp = String(ctx.body.mot_de_passe || '');
    if (!/^[a-z0-9._-]{3,40}$/.test(login)) throw new HttpError(400, 'Identifiant invalide (3 à 40 caractères : lettres minuscules, chiffres, . _ -).');
    if (nom.length < 3) throw new HttpError(400, 'Nom complet obligatoire.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Rôle invalide.');
    const errors = password.checkPolicy(tmp, login);
    if (errors.length) throw new HttpError(400, 'Mot de passe provisoire non conforme : ' + errors.join(', ') + '.');
    // Un compte Stagiaire ou Parent doit être rattaché à un dossier existant dès sa création
    const stagiaireId = int(ctx.body.stagiaire_id);
    const lien = ctx.body.lien || 'tuteur';
    let dossier = null;
    if (role === 'stagiaire' || role === 'parent') {
      dossier = (await db.query('SELECT id, cef, utilisateur_id FROM stagiaires WHERE id=$1', [stagiaireId])).rows[0];
      if (!dossier) throw new HttpError(400, 'Sélectionnez le dossier stagiaire à rattacher à ce compte.');
      if (role === 'stagiaire' && dossier.utilisateur_id) throw new HttpError(409, 'Ce stagiaire possède déjà un compte.');
      if (role === 'parent' && !app.LIENS[lien]) throw new HttpError(400, 'Lien de parenté invalide.');
    }
    try {
      const id = await db.tx(async (c) => {
        const r = await c.query(
          `INSERT INTO utilisateurs (login, nom_complet, email, role, mot_de_passe, doit_changer_mdp) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
          [login, nom, String(ctx.body.email || '').slice(0, 120) || null, role, password.hash(tmp)]);
        const uid = r.rows[0].id;
        if (role === 'stagiaire') await c.query('UPDATE stagiaires SET utilisateur_id=$2 WHERE id=$1', [dossier.id, uid]);
        if (role === 'parent') await c.query('INSERT INTO parents_stagiaires (parent_id, stagiaire_id, lien) VALUES ($1,$2,$3)', [uid, dossier.id, lien]);
        await audit.append(c, { acteur: ctx.user, action: 'compte.creation', ressource: `utilisateur:${uid}`, ip: ctx.ip,
          details: { login, role, ...(dossier ? { stagiaire: dossier.cef } : {}), ...(role === 'parent' ? { lien } : {}) } });
        return uid;
      });
      return { id };
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'Cet identifiant existe déjà.');
      throw e;
    }
  });

  router.post('/api/admin/utilisateurs/:id/action', app.requirePerm('comptes.gerer'), async (ctx) => {
    const id = int(ctx.params.id); const action = ctx.body.action;
    const u = (await db.query('SELECT * FROM utilisateurs WHERE id=$1', [id])).rows[0];
    if (!u) throw new HttpError(404, 'Compte introuvable.');
    if (u.id === ctx.user.id && ['suspendre', 'changer_role', 'reinitialiser_mfa'].includes(action)) {
      throw new HttpError(400, 'Action impossible sur votre propre compte (protection contre l\'auto-blocage).');
    }
    const revoke = () => db.query('UPDATE sessions SET revoquee=true WHERE utilisateur_id=$1', [id]);
    switch (action) {
      case 'suspendre': await db.query('UPDATE utilisateurs SET statut=\'suspendu\' WHERE id=$1', [id]); await revoke(); break;
      case 'reactiver': await db.query('UPDATE utilisateurs SET statut=\'actif\' WHERE id=$1', [id]); break;
      case 'deverrouiller': await db.query('UPDATE utilisateurs SET verrouille_jusqua=NULL, echecs_consecutifs=0 WHERE id=$1', [id]); break;
      case 'reinitialiser_mfa':
        await db.query('UPDATE utilisateurs SET mfa_active=false, mfa_secret_chiffre=NULL, mfa_dernier_pas=0 WHERE id=$1', [id]); await revoke(); break;
      case 'changer_role': {
        if (!ROLES.includes(ctx.body.role)) throw new HttpError(400, 'Rôle invalide.');
        if ([u.role, ctx.body.role].some((x) => ['stagiaire', 'parent'].includes(x))) {
          throw new HttpError(400, 'Un compte Stagiaire ou Parent est lié à un dossier : créez un nouveau compte plutôt que de changer son rôle.');
        }
        await db.query('UPDATE utilisateurs SET role=$2 WHERE id=$1', [id, ctx.body.role]); await revoke();
        if (ctx.body.role !== 'formateur') await db.query('DELETE FROM affectations WHERE formateur_id=$1', [id]);
        break;
      }
      case 'rattacher_enfant': {
        if (u.role !== 'parent') throw new HttpError(400, 'Seul un compte Parent peut être rattaché à un stagiaire.');
        const st = (await db.query('SELECT id, cef FROM stagiaires WHERE id=$1', [int(ctx.body.stagiaire_id)])).rows[0];
        const lien = ctx.body.lien || 'tuteur';
        if (!st) throw new HttpError(400, 'Dossier stagiaire introuvable.');
        if (!app.LIENS[lien]) throw new HttpError(400, 'Lien de parenté invalide.');
        await db.query('INSERT INTO parents_stagiaires (parent_id, stagiaire_id, lien) VALUES ($1,$2,$3) ON CONFLICT (parent_id, stagiaire_id) DO UPDATE SET lien = EXCLUDED.lien', [id, st.id, lien]);
        ctx.body.cef = st.cef;
        break;
      }
      case 'detacher_enfant': {
        const r = await db.query('DELETE FROM parents_stagiaires WHERE parent_id=$1 AND stagiaire_id=$2 RETURNING stagiaire_id', [id, int(ctx.body.stagiaire_id)]);
        if (!r.rows.length) throw new HttpError(404, 'Rattachement introuvable.');
        break;
      }
      default: throw new HttpError(400, 'Action inconnue.');
    }
    await app.log(ctx, `compte.${action}`, `utilisateur:${id}`, { login: u.login, ...(action === 'changer_role' ? { avant: u.role, apres: ctx.body.role } : {}),
      ...(['rattacher_enfant', 'detacher_enfant'].includes(action) ? { stagiaire: ctx.body.cef || int(ctx.body.stagiaire_id), lien: ctx.body.lien } : {}) });
    return { ok: true };
  });

  // ---------------- Sauvegardes (H5)
  router.get('/api/admin/sauvegardes', app.requirePerm('sauvegardes.gerer'), async () => {
    const r = await db.query('SELECT * FROM sauvegardes ORDER BY id DESC LIMIT 30');
    return r.rows;
  });
  router.post('/api/admin/sauvegardes', app.requirePerm('sauvegardes.gerer'), async (ctx) => {
    const b = await backup.createBackup(db, 'manuelle');
    await app.log(ctx, 'sauvegarde.creation', `sauvegarde:${b.id}`, { fichier: b.fichier, sha256: b.sha256, duree_ms: b.duree_ms });
    return b;
  });
  router.post('/api/admin/sauvegardes/:id/verifier', app.requirePerm('sauvegardes.gerer'), async (ctx) => {
    const res = await backup.verifyBackup(db, int(ctx.params.id));
    if (!res) throw new HttpError(404, 'Sauvegarde introuvable.');
    await app.log(ctx, 'sauvegarde.verification', `sauvegarde:${res.id}`, { ok: res.ok });
    return res;
  });

  // ---------------- Tableau de bord sécurité (KPI du chapitre 29ter)
  router.get('/api/securite/synthese', app.requirePerm('securite.synthese'), async () => {
    const q = async (sql, p = []) => (await db.query(sql, p)).rows[0];
    const comptes = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE mfa_active)::int mfa,
        count(*) FILTER (WHERE verrouille_jusqua > now())::int verrouilles, count(*) FILTER (WHERE statut='suspendu')::int suspendus,
        count(*) FILTER (WHERE role IN ('administrateur','gestionnaire','directeur'))::int privilegies,
        count(*) FILTER (WHERE role IN ('administrateur','gestionnaire','directeur') AND mfa_active)::int privilegies_mfa
        FROM utilisateurs WHERE statut <> 'desactive'`);
    const alertes = await q(`SELECT count(*) FILTER (WHERE statut='nouvelle')::int ouvertes,
        count(*) FILTER (WHERE statut='nouvelle' AND severite='critique')::int critiques,
        count(*) FILTER (WHERE statut='nouvelle' AND severite='avertissement')::int avertissements,
        count(*) FILTER (WHERE statut='nouvelle' AND severite='information')::int informations,
        count(*) FILTER (WHERE statut='confirmee')::int confirmees, count(*) FILTER (WHERE statut='infirmee')::int infirmees,
        coalesce(avg(extract(epoch FROM traitee_le - cree_le)/3600) FILTER (WHERE traitee_le IS NOT NULL), 0)::float delai_moyen_h,
        count(*) FILTER (WHERE cree_le > now() - interval '7 days')::int semaine FROM alertes`);
    const auth = await q(`SELECT count(*) FILTER (WHERE action='auth.connexion')::int connexions,
        count(*) FILTER (WHERE action IN ('auth.echec_mot_de_passe','auth.echec_mfa'))::int echecs,
        count(*) FILTER (WHERE action='acces.refuse')::int refus
        FROM journal_audit WHERE horodatage > $1`, [new Date(Date.now() - 86400000).toISOString()]);
    const sessions = await q('SELECT count(*)::int n FROM sessions WHERE type=\'complete\' AND NOT revoquee AND expire_le > now() AND derniere_activite > now() - interval \'30 minutes\'');
    const journal = await q('SELECT count(*)::int n FROM journal_audit');
    const save = await q('SELECT *, extract(epoch FROM now() - cree_le)/3600 AS age_h FROM sauvegardes ORDER BY id DESC LIMIT 1');
    const tendance = await db.query(
      `SELECT to_char(d, 'DD/MM') AS jour,
              (SELECT count(*)::int FROM journal_audit WHERE action='auth.connexion' AND left(horodatage,10)=to_char(d,'YYYY-MM-DD')) AS connexions,
              (SELECT count(*)::int FROM journal_audit WHERE action IN ('auth.echec_mot_de_passe','auth.echec_mfa') AND left(horodatage,10)=to_char(d,'YYYY-MM-DD')) AS echecs
         FROM generate_series(current_date - 13, current_date, '1 day') d ORDER BY d`);
    return {
      comptes, alertes, auth_24h: auth, sessions_actives: sessions.n, entrees_journal: journal.n,
      taux_mfa: comptes.total ? comptes.mfa / comptes.total : 0,
      taux_faux_positifs: (alertes.confirmees + alertes.infirmees) ? alertes.infirmees / (alertes.confirmees + alertes.infirmees) : null,
      integrite: lastIntegrity, derniere_sauvegarde: save || null, disponibilite: { demarre_depuis_h: (Date.now() - startedAt) / 3600000 },
      tendance: tendance.rows,
    };
  });

  // ---------------- Statistiques pédagogiques
  router.get('/api/stats', app.requirePerm('stats.lire'), async (ctx) => {
    const avecNotes = app.can(ctx, 'note.lire_toutes');   // le gestionnaire des stagiaires ne voit que l'assiduité
    const notes = avecNotes ? await db.query('SELECT statut, count(*)::int n FROM notes GROUP BY statut') : { rows: [] };
    const seances = await db.query('SELECT statut, count(*)::int n FROM seances GROUP BY statut');
    const parGroupe = !avecNotes ? { rows: [] } : await db.query(
      `SELECT g.code AS groupe, m.code AS module, n.type_eval, json_agg(n.valeur_chiffree) AS v, count(*)::int nb
         FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id JOIN groupes g ON g.id=s.groupe_id JOIN modules m ON m.id=n.module_id
        WHERE n.statut='validee' GROUP BY g.code, m.code, n.type_eval ORDER BY g.code, m.code`);
    const absences = await db.query(
      `SELECT g.code AS groupe, sum(jsonb_array_length(absents))::int AS absences, count(*)::int AS seances,
              sum((SELECT count(*) FROM stagiaires s WHERE s.groupe_id=g.id))::int AS presences_attendues
         FROM seances se JOIN groupes g ON g.id=se.groupe_id GROUP BY g.code ORDER BY g.code`);
    return {
      avec_notes: avecNotes,
      notes: Object.fromEntries(notes.rows.map((r) => [r.statut, r.n])),
      seances: Object.fromEntries(seances.rows.map((r) => [r.statut, r.n])),
      moyennes: parGroupe.rows.map((r) => {
        const vals = r.v.map((x) => Number(cryptoSvc.decrypt(x)));
        return { groupe: r.groupe, module: r.module, type_eval: r.type_eval, nb: r.nb, moyenne: vals.reduce((a, b) => a + b, 0) / vals.length,
          reussite: vals.filter((x) => x >= 10).length / vals.length };
      }),
      absences: absences.rows,
    };
  });

  // ---------------- Export traçé et signé par empreinte
  router.get('/api/export/lots', app.requirePerm('export.notes'), async () => {
    const r = await db.query(
      `SELECT g.id AS groupe_id, g.code AS groupe, m.id AS module_id, m.code AS module, m.intitule, n.type_eval, count(*)::int nb, max(n.valide_le) AS valide_le
         FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id JOIN groupes g ON g.id=s.groupe_id JOIN modules m ON m.id=n.module_id
        WHERE n.statut='validee' GROUP BY g.id, g.code, m.id, m.code, m.intitule, n.type_eval ORDER BY g.code, m.code, n.type_eval`);
    return r.rows;
  });

  router.get('/api/export/notes', app.requirePerm('export.notes'), async (ctx) => {
    const g = int(ctx.query.groupe_id); const m = int(ctx.query.module_id); const t = String(ctx.query.type_eval || '');
    const r = await db.query(
      `SELECT s.cef, s.nom, s.prenom, g.code AS groupe, m.code AS module, n.type_eval, n.valeur_chiffree, n.valide_le
         FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id JOIN groupes g ON g.id=s.groupe_id JOIN modules m ON m.id=n.module_id
        WHERE n.statut='validee' AND g.id=$1 AND m.id=$2 AND n.type_eval=$3 ORDER BY s.nom, s.prenom`, [g, m, t]);
    if (!r.rows.length) throw new HttpError(404, 'Aucune note validée pour ce lot.');
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = ['CEF;Nom;Prénom;Groupe;Module;Évaluation;Note;Validée le',
      ...r.rows.map((x) => [x.cef, x.nom, x.prenom, x.groupe, x.module, x.type_eval, cryptoSvc.decrypt(x.valeur_chiffree).replace('.', ','), x.valide_le?.slice(0, 10)].map(esc).join(';'))];
    const csv = '﻿' + lines.join('\r\n') + '\r\n';
    const empreinte = cryptoSvc.sha256(csv);
    const entry = await audit.log(db, { acteur: ctx.user, action: 'export.notes', ressource: `lot:${g}/${m}/${t}`, ip: ctx.ip, details: { lignes: r.rows.length, sha256: empreinte } });
    return { __raw: true, contentType: 'text/csv; charset=utf-8', filename: `notes_${r.rows[0].groupe}_${r.rows[0].module}_${t}.csv`,
      headers: { 'X-Empreinte-SHA256': empreinte, 'X-Journal-Entree': String(entry.id) }, body: csv };
  });

  // Performance administrative des formateurs (perspective) — lecture seule, directrice + administrateur.
  router.get('/api/admin/performance', app.requirePerm('performance.consulter'), async (ctx) => {
    const perf = require('../services/performance');
    const opt = {};
    if (ctx.query.delaiSaisie) opt.delaiSaisie = Math.max(0, Math.min(60, parseInt(ctx.query.delaiSaisie, 10) || 7));
    if (ctx.query.delaiSeance) opt.delaiSeance = Math.max(0, Math.min(30, parseInt(ctx.query.delaiSeance, 10) || 2));
    if (ctx.query.poids) { try { opt.poids = JSON.parse(ctx.query.poids); } catch { /* défaut */ } }
    return perf.calculer(db, opt);
  });
};
