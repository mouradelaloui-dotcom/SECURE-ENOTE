'use strict';
/**
 * Jeu de données de démonstration (personnels de l'ISTA NTIC Safi ; stagiaires fictifs). Exécuté uniquement si la base est vide.
 * Les actions passées sont rejouées à travers le journal chaîné, avec des horodatages
 * antérieurs, afin que l'historique soit vérifiable dès le premier démarrage.
 */
const cryptoSvc = require('../security/crypto');
const password = require('../security/password');
const totp = require('../security/totp');
const audit = require('../security/audit');

const USERS = [
  { login: 'm.elaloui', nom: 'Mourad Elaloui', role: 'formateur', mdp: 'Formateur@2026' },
  { login: 'y.chakir', nom: 'Youness Chakir', role: 'formateur', mdp: 'Youness#Ntic2026' },
  { login: 'z.nadifi', nom: 'Zineb Nadifi', role: 'formateur', mdp: 'Zineb#Ntic2026' },
  { login: 'jamila', nom: 'Jamila', role: 'formateur', mdp: 'Jamila#Ntic2026' },
  { login: 'e.talil', nom: 'El Mehdi Talil', role: 'gestionnaire', mdp: 'Gestion@2026' },
  { login: 'w.jakjoud', nom: 'Widad Jakjoud', role: 'directeur', mdp: 'Directeur@2026' },
  { login: 'admin.dr', nom: 'DR', role: 'administrateur', mdp: 'Admin@2026' },
  { login: 'nouveau.formateur', nom: 'Nouveau Formateur', role: 'formateur', mdp: 'Bienvenue#2026', nouveau: true },
];

const PRENOMS = ['Yassine', 'Fatima Zahra', 'Omar', 'Khadija', 'Ayoub', 'Salma', 'Mehdi', 'Hajar', 'Anas', 'Imane', 'Hamza',
  'Meryem', 'Zakaria', 'Oumaima', 'Ilyas', 'Nouhaila', 'Achraf', 'Kawtar', 'Reda', 'Chaimae', 'Soufiane', 'Douae', 'Taha', 'Ikram'];
const NOMS = ['El Fassi', 'Benjelloun', 'Amrani', 'Tahiri', 'Ouazzani', 'Berrada', 'Lahlou', 'Saidi', 'Naciri', 'Kettani',
  'Chraibi', 'Bennis', 'Alami', 'Sqalli', 'Raji', 'Hilali', 'Zouhair', 'Bouzid', 'Mansouri', 'Fikri', 'Hamdaoui', 'Rami'];

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

async function seed(db) {
  const n = await db.query('SELECT count(*)::int AS n FROM utilisateurs');
  if (n.rows[0].n > 0) return { skipped: true };
  const rand = rng(14171);
  const now = Date.now();
  const day = 86400000;
  const workTime = (daysAgo, hour, minute = 0) => {
    const d = new Date(now - daysAgo * day);
    d.setUTCHours(hour - 1, minute, Math.floor(rand() * 59), 0); // heure Maroc (UTC+1)
    return d.toISOString();
  };

  return db.tx(async (c) => {
    const events = [];
    const ev = (e) => { events.push(e); };
    const ids = {};
    for (const u of USERS) {
      const secret = totp.generateSecret();
      const r = await c.query(
        `INSERT INTO utilisateurs (login, nom_complet, email, role, mot_de_passe, mfa_secret_chiffre, mfa_active, doit_changer_mdp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [u.login, u.nom, `${u.login.replace(/\./g, '-')}@exemple-ofppt.ma`, u.role, password.hash(u.mdp),
          u.nouveau ? null : cryptoSvc.encrypt(secret, 'mfa'), !u.nouveau, !!u.nouveau]);
      ids[u.login] = { id: r.rows[0].id, login: u.login, role: u.role };
    }
    const sys = { id: null, login: 'systeme', role: null };
    ev({ acteur: sys, action: 'systeme.initialisation', details: { comptes: USERS.length }, at: workTime(21, 8) });

    const fil = {};
    for (const [code, lib] of [
      ['IDOSR', 'Infrastructure Digitale option Systèmes et Réseaux'],
      ['IDOCS', 'Infrastructure Digitale option Cyber Sécurité'],
      ['ID', 'Infrastructure Digitale — tronc commun']]) {
      fil[code] = (await c.query('INSERT INTO filieres (code, libelle) VALUES ($1,$2) RETURNING id', [code, lib])).rows[0].id;
    }
    const grp = {};
    for (const [code, lib, f, an, nb] of [
      ['IDOSR201', 'Infrastructure Digitale option Systèmes et Réseaux — 2e année — Groupe 1', 'IDOSR', '2026-2027', 13],
      ['IDOSR202', 'Infrastructure Digitale option Systèmes et Réseaux — 2e année — Groupe 2', 'IDOSR', '2026-2027', 12],
      ['IDOSR204', 'Infrastructure Digitale option Systèmes et Réseaux — 2e année — Groupe 4', 'IDOSR', '2026-2027', 12],
      ['IDOSR205', 'Infrastructure Digitale option Systèmes et Réseaux — 2e année — Groupe 5', 'IDOSR', '2026-2027', 14],
      ['IDOCS', 'Infrastructure Digitale option Cyber Sécurité — 2e année', 'IDOCS', '2026-2027', 12],
      ['ID101', 'Infrastructure Digitale — 1re année — Groupe 1', 'ID', '2026-2027', 13],
      ['ID102', 'Infrastructure Digitale — 1re année — Groupe 2', 'ID', '2026-2027', 12],
      ['ID103', 'Infrastructure Digitale — 1re année — Groupe 3', 'ID', '2026-2027', 12],
    ]) {
      grp[code] = { id: (await c.query('INSERT INTO groupes (code, libelle, filiere_id, annee) VALUES ($1,$2,$3,$4) RETURNING id', [code, lib, fil[f], an])).rows[0].id, nb, f };
    }
    const mod = {};   // clé : filière:code (les codes de module se répètent d'une filière à l'autre)
    for (const [code, intitule, f, h] of [
      ['M201', 'Mise en place d\'une infrastructure', 'IDOSR', 90],
      ['M204', 'Les enjeux du SDN', 'IDOSR', 60],
      ['M205', 'Cloud computing', 'IDOSR', 90],
      ['M202', 'Administrer un système serveur', 'IDOSR', 90],
      ['M203', 'Administration Linux', 'IDOSR', 90],
      ['M201', 'Les fondamentaux de la cybersécurité', 'IDOCS', 90],
      ['M202', 'Durcissement d\'un SI', 'IDOCS', 90],
      ['M203', 'Test d\'intrusion', 'IDOCS', 90],
      ['M103', 'Conception d\'un réseau informatique', 'ID', 90],
      ['M104', 'Fonctionnement d\'un SI', 'ID', 60],
    ]) {
      mod[`${f}:${code}`] = (await c.query('INSERT INTO modules (code, intitule, filiere_id, masse_horaire) VALUES ($1,$2,$3,$4) RETURNING id', [code, intitule, fil[f], h])).rows[0].id;
    }
    const M = (g, code) => mod[`${grp[g].f}:${code}`];
    const stag = {};
    let cef = 2026001;
    for (const [code, g] of Object.entries(grp)) {
      stag[code] = [];
      for (let i = 0; i < g.nb; i++) {
        const prenom = PRENOMS[Math.floor(rand() * PRENOMS.length)];
        const nom = NOMS[Math.floor(rand() * NOMS.length)];
        const cin = ['J', 'JA', 'JB', 'H'][i % 4] + String(100000 + Math.floor(rand() * 899999));
        const naissance = `${2003 + Math.floor(rand() * 5)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`;
        const tel = '06' + String(10000000 + Math.floor(rand() * 89999999));
        const r = await c.query(
          `INSERT INTO stagiaires (cef, nom, prenom, groupe_id, cin_chiffre, date_naissance_chiffree, telephone_chiffre)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [String(cef++), nom, prenom, g.id, cryptoSvc.encrypt(cin), cryptoSvc.encrypt(naissance), cryptoSvc.encrypt(tel)]);
        stag[code].push(r.rows[0].id);
      }
    }
    const aff = [];
    for (const g of ['IDOSR201', 'IDOSR202', 'IDOSR205']) for (const m of ['M201', 'M204', 'M205']) aff.push(['m.elaloui', g, m]);
    for (const g of ['IDOSR201', 'IDOSR202', 'IDOSR204']) for (const m of ['M202', 'M203']) aff.push(['y.chakir', g, m]);
    for (const m of ['M201', 'M202', 'M203']) aff.push(['z.nadifi', 'IDOCS', m]);
    for (const g of ['ID101', 'ID102', 'ID103']) for (const m of ['M103', 'M104']) aff.push(['jamila', g, m]);
    aff.push(['nouveau.formateur', 'ID102', 'M104']);
    for (const [f, g, m] of aff) {
      await c.query('INSERT INTO affectations VALUES ($1,$2,$3)', [ids[f].id, grp[g].id, M(g, m)]);
    }

    // ---- Historique : connexions, saisies, soumissions et validations (rejoués dans le journal)
    const G = ids['e.talil']; const D = ids['w.jakjoud'];
    const note = () => Math.round((6 + rand() * 13.5) * 4) / 4;
    async function lot(formateur, g, m, type, statut, d, ancienControle = false) {
      const F = ids[formateur];
      ev({ acteur: F, action: 'auth.connexion', details: { mfa: 'totp' }, ip: '10.20.1.' + (10 + Math.floor(rand() * 40)), at: workTime(d, 9, 5) });
      let minute = 10;
      const noteIds = [];
      for (const s of stag[g]) {
        const v = note();
        const r = await c.query(
          `INSERT INTO notes (stagiaire_id, module_id, type_eval, valeur_chiffree, statut, auteur_id, controleur_id, validateur_id, valide_le, cree_le, modifie_le)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [s, M(g, m), type, cryptoSvc.encrypt(v.toFixed(2)), statut, F.id,
            null, statut === 'validee' ? D.id : null,
            statut === 'validee' ? workTime(d - 2, 11) : null, workTime(d, 9, minute), workTime(d, 10, 2)]);
        noteIds.push(r.rows[0].id);
        ev({ acteur: F, action: 'note.saisie', ressource: `note:${r.rows[0].id}`,
          details: { groupe: g, module: m, evaluation: type, valeur: cryptoSvc.encrypt(v.toFixed(2)) }, at: workTime(d, 9, minute++) });
      }
      if (statut !== 'brouillon') ev({ acteur: F, action: 'note.soumission', ressource: `lot:${g}/${m}/${type}`, details: { notes: noteIds.length }, at: workTime(d, 10, 2) });
      if (statut === 'validee' || ancienControle) {
        // Connexion quotidienne du gestionnaire des stagiaires (suivi des absences) ; il n'intervient pas sur les notes.
        // Les deux tirages horaires sont conservés pour que le jeu de démonstration reste identique d'une version à l'autre.
        ev({ acteur: G, action: 'auth.connexion', details: { mfa: 'totp' }, ip: '10.20.1.5', at: workTime(d - 1, 8, 40) });
        workTime(d - 1, 8, 55);
      }
      if (statut === 'validee') {
        ev({ acteur: D, action: 'auth.connexion', details: { mfa: 'totp' }, ip: '10.20.1.2', at: workTime(d - 2, 10, 50) });
        ev({ acteur: D, action: 'note.validation', ressource: `lot:${g}/${m}/${type}`, details: { notes: noteIds.length }, at: workTime(d - 2, 11) });
      }
    }
    await lot('m.elaloui', 'IDOSR201', 'M201', 'CC1', 'validee', 18);
    await lot('y.chakir', 'IDOSR204', 'M203', 'CC1', 'validee', 16);
    await lot('jamila', 'ID101', 'M103', 'CC1', 'validee', 14);
    await lot('m.elaloui', 'IDOSR202', 'M205', 'CC1', 'soumise', 9, true);
    await lot('z.nadifi', 'IDOCS', 'M202', 'CC1', 'soumise', 5);
    await lot('m.elaloui', 'IDOSR201', 'M201', 'CC2', 'soumise', 3);

    const CONTENUS = {
      M201: ['Étude de l\'existant et cahier des charges de l\'infrastructure', 'Plan d\'adressage et VLAN', 'Mise en place des services DHCP et DNS', 'Routage inter-VLAN'],
      M204: ['Architecture SDN : plan de contrôle et plan de données', 'Protocole OpenFlow', 'Contrôleur SDN et virtualisation des fonctions réseau'],
      M205: ['Modèles de services IaaS, PaaS, SaaS', 'Virtualisation et hyperviseurs', 'Déploiement d\'une machine virtuelle dans le cloud'],
      M202: ['Installation de Windows Server', 'Active Directory : utilisateurs et groupes', 'Stratégies de groupe (GPO)'],
      M203: ['Gestion des utilisateurs et des droits sous Linux', 'Services systemd et journaux', 'Scripts Bash d\'administration'],
      M103: ['Topologies et supports de transmission', 'Modèle OSI et TCP/IP', 'Adressage IPv4 et sous-réseaux'],
      M104: ['Composants d\'un système d\'information', 'Flux d\'information et processus métier'],
    };
    const seances = [
      ['m.elaloui', 'IDOSR201', 'M201', 14, 'validee'], ['m.elaloui', 'IDOSR201', 'M201', 12, 'validee'],
      ['m.elaloui', 'IDOSR202', 'M205', 11, 'soumise', true], ['m.elaloui', 'IDOSR205', 'M204', 7, 'soumise', true],
      ['m.elaloui', 'IDOSR201', 'M201', 4, 'soumise'], ['m.elaloui', 'IDOSR202', 'M205', 2, 'soumise'],
      ['m.elaloui', 'IDOSR205', 'M204', 1, 'brouillon'],
      ['z.nadifi', 'IDOCS', 'M202', 6, 'soumise'], ['z.nadifi', 'IDOCS', 'M203', 3, 'a_corriger'],
      ['y.chakir', 'IDOSR204', 'M203', 10, 'validee'], ['y.chakir', 'IDOSR201', 'M202', 2, 'soumise'],
      ['jamila', 'ID101', 'M103', 8, 'validee'], ['jamila', 'ID102', 'M104', 2, 'soumise'],
    ];
    let k = 0;
    const seancesValidees = [];
    // « historique » : séances soumises sous l'ancien circuit ; leurs tirages horaires sont conservés
    // pour que le jeu de démonstration (noms, absences, dates) reste identique d'une version à l'autre.
    for (const [f, g, m, d, statut, historique = false] of seances) {
      const F = ids[f];
      const list = CONTENUS[m]; const contenu = list[k++ % list.length];
      const absents = stag[g].filter(() => rand() < 0.12);
      const dt = new Date(now - d * day).toISOString().slice(0, 10);
      const r = await c.query(
        `INSERT INTO seances (formateur_id, groupe_id, module_id, date_seance, heure_debut, heure_fin, contenu_chiffre, absents, statut, motif_retour, controleur_id, validateur_id, cree_le, modifie_le)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
        [F.id, grp[g].id, M(g, m), dt, '08:30', '11:00', cryptoSvc.encrypt(contenu), absents, statut,
          statut === 'a_corriger' ? 'Horaire incohérent avec l\'emploi du temps du groupe' : null,
          null, ['validee', 'a_corriger'].includes(statut) ? D.id : null, workTime(d, 11, 15)]);
      if (statut === 'validee' && absents.length) seancesValidees.push({ id: r.rows[0].id, d, absents });
      ev({ acteur: F, action: 'seance.declaration', ressource: `seance:${r.rows[0].id}`, details: { groupe: g, module: m, absents: absents.length }, at: workTime(d, 11, 15) });
      if (statut !== 'brouillon') ev({ acteur: F, action: 'seance.soumission', ressource: `seance:${r.rows[0].id}`, at: workTime(d, 11, 16) });
      if (statut === 'validee' || historique) workTime(Math.max(d - 1, 0), 14);
      if (statut === 'a_corriger') ev({ acteur: D, action: 'seance.retour_correction', ressource: `seance:${r.rows[0].id}`, details: { motif: 'Horaire incohérent avec l\'emploi du temps du groupe' }, at: workTime(Math.max(d - 1, 0), 14, 30) });
      if (statut === 'validee') ev({ acteur: D, action: 'seance.validation', ressource: `seance:${r.rows[0].id}`, at: workTime(Math.max(d - 2, 0), 15) });
    }
    // ---- Justificatifs d'absence enregistrés par le gestionnaire des stagiaires
    const JUSTIFS = [['certificat_medical', 'Certificat médical de 2 jours remis au secrétariat'],
      ['convocation_officielle', 'Convocation à l\'examen du permis de conduire'], ['cas_familial', null]];
    let j = 0;
    for (const sv of seancesValidees) {
      const s = sv.absents[sv.absents.length - 1];
      const [motif, commentaire] = JUSTIFS[j++ % JUSTIFS.length];
      const at = workTime(Math.max(sv.d - 3, 0), 10, 20);
      await c.query(`INSERT INTO justifications_absences (seance_id, stagiaire_id, motif, commentaire_chiffre, saisi_par, saisi_le)
                     VALUES ($1,$2,$3,$4,$5,$6)`, [sv.id, s, motif, commentaire ? cryptoSvc.encrypt(commentaire) : null, G.id, at]);
      ev({ acteur: G, action: 'auth.connexion', details: { mfa: 'totp' }, ip: '10.20.1.5', at: workTime(Math.max(sv.d - 3, 0), 10, 5) });
      ev({ acteur: G, action: 'absence.justification', ressource: `seance:${sv.id}/stagiaire:${s}`,
        details: { motif, ...(commentaire ? { commentaire: cryptoSvc.encrypt(commentaire) } : {}) }, at });
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    for (const e of events) await audit.append(c, e);
    await c.query(`INSERT INTO notifications (utilisateur_id, type, message) VALUES ($1,'retour','Une séance du ${new Date(now - 3 * day).toISOString().slice(0, 10)} (IDOCS — M203) vous a été renvoyée pour correction.')`, [ids['z.nadifi'].id]);
    return { ok: true };
  });
}

/**
 * Comptes de démonstration des espaces Stagiaire et Parent. Exécuté une seule fois, y compris sur une base
 * existante (mise à niveau) : choix déterministe d'un stagiaire d'IDOSR201 ayant une absence dans une séance
 * validée, et d'un frère ou d'une sœur (même nom) dans un groupe ayant déjà des notes validées.
 */
const MDP_STAGIAIRE = 'Stagiaire@2026';
const MDP_PARENT = 'Parent@2026';

async function seedSuivi(db) {
  const deja = await db.query("SELECT count(*)::int AS n FROM utilisateurs WHERE role IN ('stagiaire','parent')");
  if (deja.rows[0].n > 0) return { skipped: true };
  const st = await db.query(
    `SELECT s.id, s.cef, s.nom, s.prenom, g.code AS groupe,
            (SELECT count(*)::int FROM seances se WHERE se.groupe_id = s.groupe_id AND se.statut = 'validee' AND se.absents @> to_jsonb(s.id)) AS nb_abs
       FROM stagiaires s JOIN groupes g ON g.id = s.groupe_id ORDER BY s.id`);
  const rang = (x) => (x.nb_abs === 1 ? 0 : x.nb_abs > 1 ? 1 : 2);   // de préférence une seule absence
  const a = st.rows.filter((x) => x.groupe === 'IDOSR201').sort((x, y) => (rang(x) - rang(y)) || (x.id - y.id));
  if (!a.length) return { skipped: true };
  const autres = st.rows.filter((x) => ['ID101', 'IDOSR204'].includes(x.groupe));
  let aine = a[0]; let cadet = null;
  for (const x of a) { const f = autres.find((y) => y.nom === x.nom); if (f) { aine = x; cadet = f; break; } }
  const slug = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const comptes = [];
  await db.tx(async (c) => {
    const sys = { id: null, login: 'systeme', role: null };
    const creer = async (login, nom, role, mdp) => {
      const r = await c.query(
        `INSERT INTO utilisateurs (login, nom_complet, email, role, mot_de_passe, mfa_secret_chiffre, mfa_active)
         VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
        [login, nom, `${login.replace(/\./g, '-')}@exemple-ofppt.ma`, role, password.hash(mdp), cryptoSvc.encrypt(totp.generateSecret(), 'mfa')]);
      comptes.push(login);
      return r.rows[0].id;
    };
    for (const x of [aine, cadet].filter(Boolean)) {
      const uid = await creer(x.cef, `${x.prenom} ${x.nom}`, 'stagiaire', MDP_STAGIAIRE);
      await c.query('UPDATE stagiaires SET utilisateur_id = $2 WHERE id = $1', [x.id, uid]);
      await audit.append(c, { acteur: sys, action: 'compte.creation', ressource: `utilisateur:${uid}`, details: { login: x.cef, role: 'stagiaire', stagiaire: x.cef } });
    }
    const pid = await creer(`parent.${slug(aine.nom)}`, `M. ${aine.nom}`, 'parent', MDP_PARENT);
    for (const x of [aine, cadet].filter(Boolean)) {
      await c.query('INSERT INTO parents_stagiaires (parent_id, stagiaire_id, lien) VALUES ($1,$2,$3)', [pid, x.id, 'pere']);
    }
    await audit.append(c, { acteur: sys, action: 'compte.creation', ressource: `utilisateur:${pid}`,
      details: { login: `parent.${slug(aine.nom)}`, role: 'parent', lien: 'pere', stagiaires: [aine, cadet].filter(Boolean).map((x) => x.cef) } });
  });
  return { ok: true, comptes };
}

module.exports = { seed, seedSuivi, USERS, MDP_STAGIAIRE, MDP_PARENT };
