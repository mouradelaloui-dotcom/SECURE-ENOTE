-- =====================================================================
-- SECURE-eNOTE — Schéma de base de données (PostgreSQL 16)
-- Exécuté par le compte propriétaire (migrations). L'application tourne
-- ensuite avec un compte applicatif à privilèges minimaux (enote_app).
-- =====================================================================

CREATE TABLE IF NOT EXISTS utilisateurs (
  id              SERIAL PRIMARY KEY,
  login           TEXT UNIQUE NOT NULL CHECK (login ~ '^[a-z0-9._-]{3,40}$'),
  nom_complet     TEXT NOT NULL,
  email           TEXT,
  role            TEXT NOT NULL CHECK (role IN ('formateur','gestionnaire','directeur','administrateur','stagiaire','parent')),
  etablissement   TEXT NOT NULL DEFAULT 'ISTA NTIC Safi',
  mot_de_passe    TEXT NOT NULL,                 -- empreinte scrypt salée, jamais en clair
  historique_mdp  JSONB NOT NULL DEFAULT '[]',   -- 3 dernières empreintes (anti-réutilisation)
  mdp_change_le   TIMESTAMPTZ NOT NULL DEFAULT now(),
  doit_changer_mdp BOOLEAN NOT NULL DEFAULT false,
  mfa_secret_chiffre TEXT,                       -- secret TOTP chiffré AES-256-GCM
  mfa_active      BOOLEAN NOT NULL DEFAULT false,
  mfa_dernier_pas BIGINT NOT NULL DEFAULT 0,     -- anti-rejeu TOTP
  statut          TEXT NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','suspendu','desactive')),
  echecs_consecutifs INT NOT NULL DEFAULT 0,
  nb_verrouillages INT NOT NULL DEFAULT 0,
  verrouille_jusqua TIMESTAMPTZ,
  derniere_connexion TIMESTAMPTZ,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id            SERIAL PRIMARY KEY,
  jeton_hash    TEXT UNIQUE NOT NULL,           -- SHA-256 du jeton (le jeton n'est jamais stocké)
  utilisateur_id INT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('pre_mfa','complete')),
  csrf          TEXT NOT NULL,
  ip            TEXT,
  agent         TEXT,
  tentatives_mfa INT NOT NULL DEFAULT 0,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  derniere_activite TIMESTAMPTZ NOT NULL DEFAULT now(),
  expire_le     TIMESTAMPTZ NOT NULL,
  revoquee      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(utilisateur_id);

CREATE TABLE IF NOT EXISTS appareils_connus (
  utilisateur_id INT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  empreinte     TEXT NOT NULL,
  libelle       TEXT,
  premier_vu    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dernier_vu    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (utilisateur_id, empreinte)
);

CREATE TABLE IF NOT EXISTS filieres (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, libelle TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groupes (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, libelle TEXT NOT NULL,
  filiere_id INT NOT NULL REFERENCES filieres(id), annee TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS modules (
  id SERIAL PRIMARY KEY, code TEXT NOT NULL, intitule TEXT NOT NULL,
  filiere_id INT NOT NULL REFERENCES filieres(id), masse_horaire INT NOT NULL,
  UNIQUE (code, filiere_id)
);
CREATE TABLE IF NOT EXISTS stagiaires (
  id SERIAL PRIMARY KEY,
  cef TEXT UNIQUE NOT NULL,                     -- numéro d'inscription
  nom TEXT NOT NULL, prenom TEXT NOT NULL,
  groupe_id INT NOT NULL REFERENCES groupes(id),
  cin_chiffre TEXT,                             -- données personnelles chiffrées (loi 09-08)
  date_naissance_chiffree TEXT,
  telephone_chiffre TEXT
);
-- Affectations : périmètre autorisé d'un formateur (contrôle côté serveur)
CREATE TABLE IF NOT EXISTS affectations (
  formateur_id INT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  groupe_id INT NOT NULL REFERENCES groupes(id),
  module_id INT NOT NULL REFERENCES modules(id),
  PRIMARY KEY (formateur_id, groupe_id, module_id)
);

-- Cycle de vie des notes et des séances : brouillon -> soumise -> validee  (ou a_corriger)
-- (le statut 'controlee' des versions précédentes n'est plus utilisé)
CREATE TABLE IF NOT EXISTS notes (
  id SERIAL PRIMARY KEY,
  stagiaire_id INT NOT NULL REFERENCES stagiaires(id),
  module_id INT NOT NULL REFERENCES modules(id),
  type_eval TEXT NOT NULL CHECK (type_eval IN ('CC1','CC2','CC3','EFM')),
  valeur_chiffree TEXT NOT NULL,                -- AES-256-GCM (iv|tag|données)
  observation_chiffree TEXT,
  statut TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','soumise','controlee','validee','a_corriger')),
  motif_retour TEXT,
  auteur_id INT NOT NULL REFERENCES utilisateurs(id),
  controleur_id INT REFERENCES utilisateurs(id),
  validateur_id INT REFERENCES utilisateurs(id),
  version INT NOT NULL DEFAULT 1,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  valide_le TIMESTAMPTZ,
  UNIQUE (stagiaire_id, module_id, type_eval)
);

CREATE TABLE IF NOT EXISTS seances (
  id SERIAL PRIMARY KEY,
  formateur_id INT NOT NULL REFERENCES utilisateurs(id),
  groupe_id INT NOT NULL REFERENCES groupes(id),
  module_id INT NOT NULL REFERENCES modules(id),
  date_seance DATE NOT NULL,
  heure_debut TEXT NOT NULL, heure_fin TEXT NOT NULL,
  contenu_chiffre TEXT NOT NULL,
  absents JSONB NOT NULL DEFAULT '[]',          -- liste d'identifiants stagiaires absents
  statut TEXT NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','soumise','controlee','validee','a_corriger')),
  motif_retour TEXT,
  controleur_id INT REFERENCES utilisateurs(id),
  validateur_id INT REFERENCES utilisateurs(id),
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  modifie_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Journal d'audit chaîné (append-only)
CREATE TABLE IF NOT EXISTS journal_audit (
  id BIGSERIAL PRIMARY KEY,
  horodatage TEXT NOT NULL,                     -- ISO 8601 UTC, inclus dans l'empreinte
  acteur_id INT,
  acteur_login TEXT NOT NULL,
  acteur_role TEXT,
  action TEXT NOT NULL,
  ressource TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  hash_precedent TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_audit_acteur ON journal_audit(acteur_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON journal_audit(action, id);

-- Interdiction de modifier ou supprimer le journal (même pour le propriétaire)
CREATE OR REPLACE FUNCTION journal_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Le journal d''audit est en ajout seul (append-only)';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_journal_append_only ON journal_audit;
CREATE TRIGGER trg_journal_append_only BEFORE UPDATE OR DELETE ON journal_audit
  FOR EACH ROW EXECUTE FUNCTION journal_append_only();

-- Journal technique (diagnostic des erreurs, distinct du journal d'audit)
CREATE TABLE IF NOT EXISTS journal_technique (
  id BIGSERIAL PRIMARY KEY,
  horodatage TIMESTAMPTZ NOT NULL DEFAULT now(),
  niveau TEXT NOT NULL,
  module TEXT,
  message TEXT NOT NULL,
  reference TEXT,                               -- référence communiquée à l'utilisateur
  details JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS regles_detection (
  code TEXT PRIMARY KEY,
  libelle TEXT NOT NULL,
  description TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  severite TEXT NOT NULL CHECK (severite IN ('information','avertissement','critique')),
  parametres JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS alertes (
  id SERIAL PRIMARY KEY,
  regle TEXT NOT NULL,
  severite TEXT NOT NULL CHECK (severite IN ('information','avertissement','critique')),
  titre TEXT NOT NULL,
  utilisateur_id INT REFERENCES utilisateurs(id),
  details JSONB NOT NULL DEFAULT '{}',
  statut TEXT NOT NULL DEFAULT 'nouvelle' CHECK (statut IN ('nouvelle','confirmee','infirmee')),
  traitee_par INT REFERENCES utilisateurs(id),
  traitee_le TIMESTAMPTZ,
  commentaire TEXT,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  utilisateur_id INT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  lue BOOLEAN NOT NULL DEFAULT false,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sauvegardes (
  id SERIAL PRIMARY KEY,
  fichier TEXT NOT NULL,
  taille BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  hash_journal TEXT,                            -- ancrage : dernière empreinte du journal
  declencheur TEXT NOT NULL,
  duree_ms INT NOT NULL,
  verifiee_le TIMESTAMPTZ,
  verification_ok BOOLEAN,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parametres (
  cle TEXT PRIMARY KEY, valeur JSONB NOT NULL
);

-- =====================================================================
-- Espaces Stagiaire et Parent : consultation des notes validées et de l'assiduité
-- (mise à niveau sans perte d'une base existante : instructions idempotentes)
-- =====================================================================
ALTER TABLE utilisateurs DROP CONSTRAINT IF EXISTS utilisateurs_role_check;
ALTER TABLE utilisateurs ADD CONSTRAINT utilisateurs_role_check
  CHECK (role IN ('formateur','gestionnaire','directeur','administrateur','stagiaire','parent'));

-- Un compte stagiaire est rattaché à un et un seul dossier stagiaire
ALTER TABLE stagiaires ADD COLUMN IF NOT EXISTS utilisateur_id INT UNIQUE REFERENCES utilisateurs(id) ON DELETE SET NULL;

-- Rattachement parent / tuteur <-> stagiaire(s), établi par l'administration uniquement
CREATE TABLE IF NOT EXISTS parents_stagiaires (
  parent_id    INT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  stagiaire_id INT NOT NULL REFERENCES stagiaires(id) ON DELETE CASCADE,
  lien         TEXT NOT NULL DEFAULT 'tuteur' CHECK (lien IN ('pere','mere','tuteur')),
  cree_le      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_id, stagiaire_id)
);
CREATE INDEX IF NOT EXISTS idx_parents_stagiaire ON parents_stagiaires(stagiaire_id);

-- =====================================================================
-- Circuits en deux étapes (formateur -> directrice) pour les notes et les séances.
-- Le gestionnaire des stagiaires gère uniquement les absences et leurs justificatifs.
-- Les éléments déjà « contrôlés » retournent en attente de la direction (mise à niveau sans perte).
-- =====================================================================
UPDATE notes   SET statut = 'soumise' WHERE statut = 'controlee';
UPDATE seances SET statut = 'soumise' WHERE statut = 'controlee';

-- Justification d'une absence (une absence = un stagiaire absent à une séance validée)
CREATE TABLE IF NOT EXISTS justifications_absences (
  seance_id    INT NOT NULL REFERENCES seances(id) ON DELETE CASCADE,
  stagiaire_id INT NOT NULL REFERENCES stagiaires(id) ON DELETE CASCADE,
  motif        TEXT NOT NULL CHECK (motif IN ('certificat_medical','convocation_officielle','cas_familial','autre')),
  commentaire_chiffre TEXT,                     -- précisions éventuelles (AES-256-GCM : donnée personnelle)
  saisi_par    INT NOT NULL REFERENCES utilisateurs(id),
  saisi_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (seance_id, stagiaire_id)
);
