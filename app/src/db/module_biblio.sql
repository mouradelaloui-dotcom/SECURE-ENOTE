-- =====================================================================
--  SECURE-eNOTE — Module « Bibliothèque numérique »
--  Catalogue de ressources pédagogiques (supports de cours, livres,
--  articles, liens, logiciels). On ne stocke PAS de fichier binaire :
--  seul le descriptif + un lien optionnel sont conservés, afin de
--  préserver le plafond anti-DoS (corps de requête <= 1 Mo) et de
--  garder une surface d'attaque minimale (ni upload, ni parcours de
--  chemin de fichier). À lancer avec le rôle enote_owner.
-- =====================================================================
CREATE TABLE IF NOT EXISTS ressources (
  id          SERIAL PRIMARY KEY,
  titre       TEXT NOT NULL,
  auteur      TEXT,
  categorie   TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'support_cours'
              CHECK (type IN ('support_cours','livre','article','lien','logiciel','autre')),
  filiere     TEXT,
  description TEXT,
  lien        TEXT,
  ajoute_par  INT REFERENCES utilisateurs(id) ON DELETE SET NULL,
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ressources_categorie ON ressources(categorie);
CREATE INDEX IF NOT EXISTS idx_ressources_type ON ressources(type);

GRANT SELECT, INSERT, UPDATE, DELETE ON ressources TO enote_app;
GRANT USAGE, SELECT ON SEQUENCE ressources_id_seq TO enote_app;

-- Quelques ressources de démonstration (ignorées si déjà présentes).
INSERT INTO ressources (titre, auteur, categorie, type, filiere, description, lien, ajoute_par)
SELECT * FROM (VALUES
  ('Support de cours — Développement Web (HTML/CSS/JS)', 'Équipe NTIC', 'Développement', 'support_cours', 'DEV', 'Fascicule complet du module développement front-end, exercices inclus.', NULL),
  ('MDN Web Docs', 'Mozilla', 'Développement', 'lien', 'DEV', 'Référence officielle HTML, CSS et JavaScript.', 'https://developer.mozilla.org'),
  ('Les réseaux pour les nuls', 'D. Lowe', 'Réseaux & Systèmes', 'livre', 'TRI', 'Introduction accessible aux concepts réseau (TCP/IP, routage, Wi-Fi).', NULL),
  ('Guide OWASP Top 10', 'OWASP', 'Sécurité informatique', 'article', NULL, 'Les 10 risques de sécurité applicative les plus répandus.', 'https://owasp.org/www-project-top-ten/'),
  ('Support — Bases de données relationnelles & SQL', 'Équipe NTIC', 'Bases de données', 'support_cours', 'DEV', 'Modèle relationnel, normalisation, requêtes SQL, PostgreSQL.', NULL),
  ('PostgreSQL', 'PostgreSQL Global Dev Group', 'Bases de données', 'logiciel', NULL, 'Système de gestion de base de données libre utilisé par SECURE-eNOTE.', 'https://www.postgresql.org')
) AS v(titre, auteur, categorie, type, filiere, description, lien),
LATERAL (SELECT id FROM utilisateurs WHERE role='formateur' ORDER BY id LIMIT 1) u(id)
WHERE NOT EXISTS (SELECT 1 FROM ressources r WHERE r.titre = v.titre);
