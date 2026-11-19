-- Module « Emploi du temps » — migration. À lancer UNE FOIS avec le compte PROPRIÉTAIRE (enote_owner).
-- Idempotent.

CREATE TABLE IF NOT EXISTS emploi_du_temps (
  id SERIAL PRIMARY KEY,
  groupe_id    INT  NOT NULL REFERENCES groupes(id) ON DELETE CASCADE,
  jour         SMALLINT NOT NULL CHECK (jour BETWEEN 1 AND 6), -- 1 = lundi ... 6 = samedi
  heure_debut  TEXT NOT NULL,
  heure_fin    TEXT NOT NULL,
  module_id    INT  NOT NULL REFERENCES modules(id),
  formateur_id INT  NOT NULL REFERENCES utilisateurs(id),
  salle        TEXT,
  UNIQUE (groupe_id, jour, heure_debut)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON emploi_du_temps TO enote_app;
GRANT USAGE, SELECT ON SEQUENCE emploi_du_temps_id_seq TO enote_app;
