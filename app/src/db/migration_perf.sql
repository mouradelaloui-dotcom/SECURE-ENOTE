-- Migration pour le module Performance : indicateurs pédagogiques.
-- À exécuter UNE FOIS avec le compte PROPRIÉTAIRE (enote_owner), pas le compte applicatif.
-- Idempotent : peut être relancée sans risque.

-- 1) Statut du stagiaire (pour le taux de déperdition). Saisi par la direction / le gestionnaire.
ALTER TABLE stagiaires
  ADD COLUMN IF NOT EXISTS statut TEXT NOT NULL DEFAULT 'actif'
  CHECK (statut IN ('actif','abandon','exclu','diplome'));

-- 2) Évaluation qualitative saisie par la direction (créativité, note globale, commentaire).
CREATE TABLE IF NOT EXISTS perf_direction (
  formateur_id INT PRIMARY KEY REFERENCES utilisateurs(id) ON DELETE CASCADE,
  creativite   NUMERIC(4,1) CHECK (creativite >= 0 AND creativite <= 20),
  note_globale NUMERIC(4,1) CHECK (note_globale >= 0 AND note_globale <= 20),
  commentaire  TEXT,
  maj_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_par      INT REFERENCES utilisateurs(id)
);

-- 3) Droits pour le compte applicatif restreint.
GRANT SELECT ON stagiaires TO enote_app;
GRANT SELECT, INSERT, UPDATE ON perf_direction TO enote_app;
