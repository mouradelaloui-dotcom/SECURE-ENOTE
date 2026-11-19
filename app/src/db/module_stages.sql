-- Module « Stages » — migration. À lancer UNE FOIS avec le compte PROPRIÉTAIRE (enote_owner). Idempotent.

CREATE TABLE IF NOT EXISTS stages (
  id SERIAL PRIMARY KEY,
  stagiaire_id INT  NOT NULL REFERENCES stagiaires(id) ON DELETE CASCADE,
  entreprise   TEXT NOT NULL,
  ville        TEXT,
  tuteur       TEXT,                                   -- tuteur en entreprise
  encadrant_id INT  REFERENCES utilisateurs(id),       -- formateur encadrant
  date_debut   DATE,
  date_fin     DATE,
  sujet        TEXT,
  statut       TEXT NOT NULL DEFAULT 'en_recherche'
               CHECK (statut IN ('en_recherche','en_cours','termine','valide')),
  maj_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stages_stagiaire ON stages(stagiaire_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON stages TO enote_app;
GRANT USAGE, SELECT ON SEQUENCE stages_id_seq TO enote_app;
