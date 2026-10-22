'use strict';
/**
 * Espaces Stagiaire et Parent : consultation en lecture seule des notes VALIDÉES et de l'assiduité.
 *
 * Règles de sécurité appliquées :
 *  - le stagiaire n'indique jamais quel dossier il consulte : le serveur le déduit de la session
 *    (aucun identifiant manipulable dans l'adresse, donc pas d'IDOR possible) ;
 *  - le parent ne peut consulter que les stagiaires rattachés à son compte par l'administration ;
 *    toute autre tentative est refusée, tracée « ACCÈS REFUSÉ » et compte pour la règle de détection ;
 *  - seules les notes validées par la direction sont publiées ; une évaluation encore dans le circuit
 *    apparaît « en validation », sans sa valeur ;
 *  - minimisation des données (loi 09-08) : ni CIN, ni téléphone, ni date de naissance ne sont renvoyés ;
 *  - chaque consultation est inscrite au journal d'audit chaîné.
 */
const cryptoSvc = require('../security/crypto');
const { HttpError } = require('../lib/http');

const EVALS = ['CC1', 'CC2', 'CC3', 'EFM'];
const EN_CIRCUIT = ['soumise', 'a_corriger'];
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const LIENS = { pere: 'Père', mere: 'Mère', tuteur: 'Tuteur / tutrice' };

module.exports = function suiviRoutes(router, app) {
  const { db } = app;

  /** Construit le dossier pédagogique publiable d'un stagiaire. */
  async function dossier(stagiaireId) {
    const s = (await db.query(
      `SELECT s.id, s.cef, s.nom, s.prenom, g.id AS groupe_id, g.code AS groupe, g.libelle AS groupe_libelle, g.annee,
              f.code AS filiere, f.libelle AS filiere_libelle
         FROM stagiaires s JOIN groupes g ON g.id = s.groupe_id JOIN filieres f ON f.id = g.filiere_id
        WHERE s.id = $1`, [stagiaireId])).rows[0];
    if (!s) throw new HttpError(404, 'Dossier introuvable.');

    const modules = await db.query(
      `SELECT m.id, m.code, m.intitule, m.masse_horaire, string_agg(DISTINCT u.nom_complet, ', ') AS formateurs
         FROM affectations a JOIN modules m ON m.id = a.module_id JOIN utilisateurs u ON u.id = a.formateur_id
        WHERE a.groupe_id = $1 AND u.role = 'formateur'
        GROUP BY m.id, m.code, m.intitule, m.masse_horaire ORDER BY m.code`, [s.groupe_id]);
    const notes = await db.query(
      'SELECT module_id, type_eval, statut, valeur_chiffree, valide_le FROM notes WHERE stagiaire_id = $1', [stagiaireId]);

    const parModule = new Map(modules.rows.map((m) => [m.id, {
      code: m.code, intitule: m.intitule, masse_horaire: m.masse_horaire, formateurs: m.formateurs,
      evaluations: Object.fromEntries(EVALS.map((e) => [e, { etat: 'non_evaluee' }])),
    }]));
    let publiees = 0; let enValidation = 0;
    for (const n of notes.rows) {
      const m = parModule.get(n.module_id);
      if (!m) continue;
      if (n.statut === 'validee') {
        m.evaluations[n.type_eval] = { etat: 'publiee', valeur: Number(cryptoSvc.decrypt(n.valeur_chiffree)), publiee_le: n.valide_le };
        publiees++;
      } else if (EN_CIRCUIT.includes(n.statut)) {
        m.evaluations[n.type_eval] = { etat: 'en_validation' };   // valeur jamais transmise avant validation
        enValidation++;
      }
    }
    const lignes = [...parModule.values()].map((m) => {
      const vals = Object.values(m.evaluations).filter((e) => e.etat === 'publiee').map((e) => e.valeur);
      return { ...m, moyenne: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    });
    const moyennes = lignes.map((l) => l.moyenne).filter((x) => x !== null);

    // Assiduité : séances validées par la direction uniquement
    const seances = await db.query(
      `SELECT se.date_seance, se.heure_debut, se.heure_fin, m.code AS module, m.intitule, u.nom_complet AS formateur,
              se.absents @> to_jsonb($2::int) AS absent, ja.motif AS justification
         FROM seances se JOIN modules m ON m.id = se.module_id JOIN utilisateurs u ON u.id = se.formateur_id
         LEFT JOIN justifications_absences ja ON ja.seance_id = se.id AND ja.stagiaire_id = $2
        WHERE se.groupe_id = $1 AND se.statut = 'validee'
        ORDER BY se.date_seance DESC, se.heure_debut DESC`, [s.groupe_id, stagiaireId]);
    const absences = seances.rows.filter((x) => x.absent).map(({ absent, ...x }) => x);

    return {
      stagiaire: { id: s.id, cef: s.cef, nom: s.nom, prenom: s.prenom, groupe: s.groupe, groupe_libelle: s.groupe_libelle,
        annee: s.annee, filiere: s.filiere, filiere_libelle: s.filiere_libelle },
      modules: lignes,
      synthese: {
        moyenne_indicative: moyennes.length ? moyennes.reduce((a, b) => a + b, 0) / moyennes.length : null,
        evaluations_publiees: publiees, evaluations_en_validation: enValidation,
        seances_validees: seances.rows.length, absences: absences.length,
        absences_justifiees: absences.filter((a) => a.justification).length,
        assiduite: seances.rows.length ? 1 - absences.length / seances.rows.length : null,
      },
      absences,
    };
  }

  // ---------------- Espace Stagiaire : son propre dossier, identifié par la session
  router.get('/api/stagiaire/dossier', app.requirePerm('dossier.lire_soi'), async (ctx) => {
    const s = (await db.query('SELECT id FROM stagiaires WHERE utilisateur_id = $1', [ctx.user.id])).rows[0];
    if (!s) throw new HttpError(404, 'Aucun dossier stagiaire n\'est rattaché à ce compte. Contactez l\'administration de l\'établissement.');
    const d = await dossier(s.id);
    await app.log(ctx, 'dossier.consultation', `stagiaire:${s.id}`, { par: 'stagiaire' });
    return d;
  });

  // ---------------- Espace Parent : uniquement les stagiaires rattachés par l'administration
  router.get('/api/parent/enfants', app.requirePerm('dossier.lire_enfants'), async (ctx) => {
    const r = await db.query(
      'SELECT stagiaire_id, lien FROM parents_stagiaires WHERE parent_id = $1 ORDER BY stagiaire_id', [ctx.user.id]);
    const enfants = [];
    for (const x of r.rows) {
      const d = await dossier(x.stagiaire_id);
      enfants.push({ ...d.stagiaire, lien: x.lien, lien_libelle: LIENS[x.lien], synthese: d.synthese });
    }
    await app.log(ctx, 'dossier.consultation', 'parent:liste', { enfants: enfants.length });
    return enfants;
  });

  router.get('/api/parent/enfants/:id', app.requirePerm('dossier.lire_enfants'), async (ctx) => {
    const id = int(ctx.params.id);
    const lien = (await db.query('SELECT lien FROM parents_stagiaires WHERE parent_id = $1 AND stagiaire_id = $2', [ctx.user.id, id])).rows[0];
    if (!lien) await app.denied(ctx, `stagiaire:${id}`, 'stagiaire non rattaché à ce compte parent');
    const d = await dossier(id);
    await app.log(ctx, 'dossier.consultation', `stagiaire:${id}`, { par: 'parent', lien: lien.lien });
    return { ...d, lien: lien.lien, lien_libelle: LIENS[lien.lien] };
  });

  // ---------------- Administration : recherche d'un dossier stagiaire pour créer / rattacher un compte
  router.get('/api/admin/stagiaires', app.requirePerm('comptes.gerer'), async (ctx) => {
    const q = String(ctx.query.q || '').trim().slice(0, 40);
    if (q.length < 2) return [];
    const r = await db.query(
      `SELECT s.id, s.cef, s.nom, s.prenom, g.code AS groupe, u.login AS compte,
              (SELECT count(*)::int FROM parents_stagiaires ps WHERE ps.stagiaire_id = s.id) AS parents
         FROM stagiaires s JOIN groupes g ON g.id = s.groupe_id LEFT JOIN utilisateurs u ON u.id = s.utilisateur_id
        WHERE s.cef = $1 OR s.nom ILIKE '%' || $1 || '%' OR s.prenom ILIKE '%' || $1 || '%' OR g.code ILIKE $1
        ORDER BY g.code, s.nom, s.prenom LIMIT 30`, [q]);
    return r.rows;
  });

  app.LIENS = LIENS;
};
