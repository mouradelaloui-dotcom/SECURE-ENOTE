'use strict';
/**
 * Module « Performance administrative des formateurs » (perspective SECURE-eNOTE).
 *
 * Calcule, EN TEMPS RÉEL et à partir des données déjà présentes dans eNote
 * (tables notes / seances / affectations / stagiaires et journal d'audit), une
 * note de ponctualité par formateur. Aucune donnée nouvelle n'est collectée :
 * on ne mesure que le respect des délais administratifs et la rigueur de saisie,
 * jamais la qualité pédagogique.
 *
 * Dates limites (« les deux ») :
 *   - règle AUTOMATIQUE par défaut : date limite = date de la dernière séance
 *     du (groupe, module) + DELAI_SAISIE_JOURS ;
 *   - CORRECTION manuelle possible : une ligne dans la table `echeances` prime
 *     sur la règle automatique pour un (groupe, module, type) donné.
 *
 * Sécurité : lecture seule. Aucune écriture dans les notes ni dans le journal.
 */

const DELAI_SAISIE_JOURS = 7;   // règle auto : jours accordés après la dernière séance
const DELAI_SEANCE_JOURS = 2;   // séance considérée « à temps » si déclarée sous 2 jours

// Poids par défaut des critères (somme = 100). Modifiables par l'appelant.
const POIDS_DEFAUT = {
  cc: 18, efm: 22, valide1: 12, pointage: 16, absences: 14, complet: 18,
};

const SEUIL = { rapide: 70, moyen: 50 };

/**
 * Crée la table des échéances si elle n'existe pas ET si le compte en a le droit.
 * Le compte applicatif (enote_app) est volontairement restreint : il ne peut pas
 * créer de table. Dans ce cas on n'échoue pas — on fonctionne en règle automatique.
 * Renvoie true si la table `echeances` est disponible (surcharges manuelles possibles).
 */
async function assurerTable(db) {
  const exist = await db.query("SELECT to_regclass('public.echeances') AS t");
  if (exist.rows[0].t) return true;
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS echeances (
        groupe_id  INT  NOT NULL REFERENCES groupes(id),
        module_id  INT  NOT NULL REFERENCES modules(id),
        type_eval  TEXT NOT NULL CHECK (type_eval IN ('CC1','CC2','CC3','EFM')),
        date_limite DATE NOT NULL,
        PRIMARY KEY (groupe_id, module_id, type_eval)
      );`);
    return true;
  } catch {
    return false; // droits insuffisants : règle automatique seulement
  }
}

function classe(note) {
  return note > SEUIL.rapide ? 'rapide' : note >= SEUIL.moyen ? 'moyen' : 'long';
}

/**
 * Renvoie la liste des formateurs avec, pour chacun, le détail des critères (en %),
 * le retard moyen (jours), la note /100 et le rythme.
 * @param {object} db   pool PostgreSQL
 * @param {object} opt  { delaiSaisie, delaiSeance, poids }
 */
async function calculer(db, opt = {}) {
  const avecEcheances = await assurerTable(db);
  const delaiSaisie = opt.delaiSaisie ?? DELAI_SAISIE_JOURS;
  const delaiSeance = opt.delaiSeance ?? DELAI_SEANCE_JOURS;
  const poids = { ...POIDS_DEFAUT, ...(opt.poids || {}) };

  // 1) Notes : ponctualité CC/EFM et retard, par formateur.
  //    Échéance = surcharge manuelle (table echeances, si disponible) OU, à défaut,
  //    dernière séance du groupe+module + délai (règle automatique).
  const dateLimiteExpr = avecEcheances ? 'COALESCE(e.date_limite, a.date_limite)' : 'a.date_limite';
  const jointureEcheances = avecEcheances
    ? 'LEFT JOIN echeances e ON e.groupe_id = s.groupe_id AND e.module_id = n.module_id AND e.type_eval = n.type_eval'
    : '';
  const notes = await db.query(`
    WITH ech_auto AS (
      SELECT groupe_id, module_id, (MAX(date_seance) + ($1 || ' days')::interval)::date AS date_limite
      FROM seances GROUP BY groupe_id, module_id
    )
    SELECT n.auteur_id AS formateur_id, n.type_eval,
           n.cree_le::date AS date_saisie,
           ${dateLimiteExpr} AS date_limite,
           n.statut, n.version
    FROM notes n
    JOIN stagiaires s ON s.id = n.stagiaire_id
    ${jointureEcheances}
    LEFT JOIN ech_auto  a ON a.groupe_id = s.groupe_id AND a.module_id = n.module_id
    WHERE n.statut <> 'brouillon'
  `, [String(delaiSaisie)]);

  // 2) Séances : pointage le jour même et déclaration à temps, par formateur.
  const seances = await db.query(`
    SELECT formateur_id,
           (cree_le::date = date_seance)                              AS jour_meme,
           (cree_le::date <= date_seance + ($1 || ' days')::interval) AS a_temps
    FROM seances
  `, [String(delaiSeance)]);

  // 3) Complétude : notes saisies ÷ notes attendues (affectations × stagiaires × 4 évaluations).
  const attendu = await db.query(`
    SELECT a.formateur_id, SUM(cnt.n) * 4 AS attendues
    FROM affectations a
    JOIN (SELECT groupe_id, COUNT(*) AS n FROM stagiaires GROUP BY groupe_id) cnt
      ON cnt.groupe_id = a.groupe_id
    GROUP BY a.formateur_id
  `);

  // 4) Liste des formateurs actifs.
  const formateurs = await db.query(
    `SELECT id, login, nom_complet FROM utilisateurs WHERE role='formateur' AND statut='actif' ORDER BY nom_complet`);

  // --- Agrégation en mémoire ---
  const M = new Map();
  const init = () => ({
    ccTot: 0, ccOk: 0, efmTot: 0, efmOk: 0,
    valTot: 0, valOk: 0, saisies: 0,
    seaTot: 0, seaJour: 0, seaTemps: 0,
    retardJours: 0, retardN: 0,
  });
  for (const f of formateurs.rows) M.set(f.id, { ...f, ...init() });

  const jour = (d) => Math.floor(new Date(d).getTime() / 86400000); // numéro de jour
  for (const r of notes.rows) {
    const m = M.get(r.formateur_id); if (!m) continue;
    m.saisies++;
    const estCC = r.type_eval.startsWith('CC');
    if (r.date_limite) {
      const jSaisie = jour(r.date_saisie); const jLimite = jour(r.date_limite);
      const aTemps = jSaisie <= jLimite;
      const retard = Math.max(0, jSaisie - jLimite);
      m.retardJours += retard; m.retardN++;
      if (estCC) { m.ccTot++; if (aTemps) m.ccOk++; }
      else { m.efmTot++; if (aTemps) m.efmOk++; }
    }
    if (r.statut === 'validee') { m.valTot++; if (Number(r.version) === 1) m.valOk++; }
  }
  for (const r of seances.rows) {
    const m = M.get(r.formateur_id); if (!m) continue;
    m.seaTot++; if (r.jour_meme) m.seaJour++; if (r.a_temps) m.seaTemps++;
  }
  const attMap = new Map(attendu.rows.map((x) => [x.formateur_id, Number(x.attendues)]));

  const pc = (ok, tot) => (tot > 0 ? Math.round((ok / tot) * 100) : null);

  const lignes = [];
  for (const m of M.values()) {
    const attendues = attMap.get(m.id) || 0;
    const crit = {
      cc: pc(m.ccOk, m.ccTot),
      efm: pc(m.efmOk, m.efmTot),
      valide1: pc(m.valOk, m.valTot),
      pointage: pc(m.seaJour, m.seaTot),
      absences: pc(m.seaTemps, m.seaTot),
      complet: attendues > 0 ? Math.min(100, Math.round((m.saisies / attendues) * 100)) : null,
    };
    const retardMoyen = m.retardN > 0 ? m.retardJours / m.retardN : 0;

    // Moyenne pondérée sur les seuls critères mesurables (poids renormalisé).
    let sommeW = 0; let sommeWX = 0;
    for (const k of Object.keys(poids)) {
      if (crit[k] !== null) { sommeW += poids[k]; sommeWX += poids[k] * crit[k]; }
    }
    const base = sommeW > 0 ? sommeWX / sommeW : 0;
    const evalue = sommeW > 0;   // au moins un critère mesurable
    const note = evalue ? Math.max(0, Math.min(100, Math.round(base - 2 * retardMoyen))) : null;

    lignes.push({
      formateur_id: m.id, login: m.login, nom: m.nom_complet,
      criteres: crit,
      retard_moyen_jours: Math.round(retardMoyen * 10) / 10,
      donnees: { notes_saisies: m.saisies, notes_attendues: attendues, seances: m.seaTot },
      note, rythme: evalue ? classe(note) : 'non évalué',
    });
  }
  lignes.sort((a, b) => (b.note ?? -1) - (a.note ?? -1));
  return { genere_le: new Date().toISOString(), delaiSaisie, delaiSeance, poids, seuils: SEUIL, avec_echeances: avecEcheances, formateurs: lignes };
}

module.exports = { calculer, assurerTable, POIDS_DEFAUT, SEUIL, classe };

// --- Exécution directe : `node src/services/performance.js` (affiche un tableau) ---
if (require.main === module) {
  (async () => {
    const config = require('../config');
    const { Pool } = require('../lib/pg');
    const db = new Pool({ ...config.db, max: 2 });
    try {
      const res = await calculer(db);
      const pad = (s, n) => String(s ?? '—').padEnd(n);
      const padL = (s, n) => String(s ?? '—').padStart(n);
      console.log(`\nPerformance administrative — généré le ${res.genere_le}`);
      console.log(`Règle auto : date limite = dernière séance + ${res.delaiSaisie} j · séance à temps sous ${res.delaiSeance} j\n`);
      console.log(pad('Formateur', 22) + pad('CC', 5) + pad('EFM', 5) + pad('Val1', 6) + pad('Point', 7) + pad('Abs', 6) + pad('Compl', 7) + pad('Ret.j', 7) + padL('Note', 5) + '  Rythme');
      console.log('-'.repeat(86));
      const show = (v) => (v === null ? '—' : v + '%');
      for (const f of res.formateurs) {
        const c = f.criteres;
        console.log(
          pad(f.nom, 22) + pad(show(c.cc), 5) + pad(show(c.efm), 5) + pad(show(c.valide1), 6) +
          pad(show(c.pointage), 7) + pad(show(c.absences), 6) + pad(show(c.complet), 7) +
          pad(f.retard_moyen_jours, 7) + padL(f.note, 5) + '  ' + f.rythme);
      }
      if (!res.formateurs.length) console.log('(aucun formateur actif, ou aucune donnée à mesurer)');
      console.log('');
    } catch (e) {
      console.error('Erreur :', e.message);
      process.exitCode = 1;
    } finally {
      db.end?.();
      process.exit();
    }
  })();
}
