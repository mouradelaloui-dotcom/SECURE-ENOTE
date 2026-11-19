-- =====================================================================
--  SECURE-eNOTE — Registre des modules (« magasin de modules »)
--  Permet à l'administrateur d'activer / désactiver des modules DÉJÀ
--  installés et vérifiés. On n'exécute JAMAIS de code téléchargé : on
--  ne fait qu'allumer ou éteindre des modules présents dans le dépôt.
--  Un module désactivé voit ses routes renvoyer 404 et son menu masqué.
--  Le module « core » (socle : notes, séances, absences, sécurité) est
--  verrouillé : il ne peut pas être désactivé.
--  À lancer avec le rôle enote_owner.
-- =====================================================================
CREATE TABLE IF NOT EXISTS modules_installes (
  id          TEXT PRIMARY KEY,
  nom         TEXT NOT NULL,
  description TEXT,
  categorie   TEXT NOT NULL DEFAULT 'Métier',
  version     TEXT NOT NULL DEFAULT '1.0.0',
  verrou      BOOLEAN NOT NULL DEFAULT false,   -- true = non désactivable (socle)
  actif       BOOLEAN NOT NULL DEFAULT true,
  maj_le      TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON modules_installes TO enote_app;

-- Catalogue des modules présents (inséré une seule fois).
INSERT INTO modules_installes (id, nom, description, categorie, version, verrou, actif) VALUES
  ('core',         'Socle eNote',          'Notes, séances, absences, comptes, sécurité et journal d''audit. Indispensable.', 'Socle', '1.0.0', true,  true),
  ('emploi-du-temps','Emploi du temps',    'Planning hebdomadaire des groupes et des formateurs, avec contrôle des chevauchements.', 'Métier', '1.0.0', false, true),
  ('stages',       'Stages',               'Suivi des stages des stagiaires : entreprise, encadrant, période, statut.', 'Métier', '1.0.0', false, true),
  ('bibliotheque', 'Bibliothèque numérique','Catalogue de ressources pédagogiques (supports, livres, liens).', 'Métier', '1.0.0', false, true),
  ('performance',  'Performance formateurs','Indicateurs de ponctualité et de suivi mesurés sur les données eNote.', 'Pilotage', '1.0.0', false, true)
ON CONFLICT (id) DO NOTHING;
