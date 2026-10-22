# SECURE-eNOTE — Prototype applicatif sécurisé

Gestion sécurisée des notes et des séances (OFPPT — ISTA NTIC Safi).
Projet de recherche appliquée — Concours de promotion interne, Échelle 22, 2026 — ELALOUI Mourad.

## Démarrage (Docker Desktop)

Prérequis : Docker Desktop (Windows, macOS ou Linux) et une connexion Internet au premier lancement (téléchargement des images `node`, `postgres` et `nginx`).

```powershell
cd secure-enote
docker compose up -d --build
```

Attendez environ une minute, puis ouvrez **https://localhost:8443**.
Le certificat est auto-signé : acceptez l'avertissement du navigateur (« Paramètres avancés » → « Continuer vers localhost »).

Arrêter : `docker compose down` — Tout réinitialiser (base, sauvegardes, certificat) : `docker compose down -v`.

## Installation de production (serveur de l'OFPPT)

En production, la base démarre **vide** (aucune donnée fictive) et le mode démonstration est désactivé. Créez un fichier `.env` à côté de `docker-compose.yml` :

```
DEMO_MODE=false
DEMO_DATA=false
```

Puis :

```bash
docker compose up -d --build
docker compose exec app node src/cli.js creer-admin admin.ista "Administrateur ISTA"   # mot de passe provisoire affiché une fois
docker compose run --rm -v ./import:/import:ro app node src/cli.js importer /import    # référentiel : filieres, groupes, modules, stagiaires, affectations (CSV ;)
```

Les comptes des formateurs sont créés par l'administrateur dans « Comptes et rôles » avant l'import du fichier `affectations.csv`.
Le guide complet (prérequis, pare-feu, certificat, sauvegarde hors site, mise à jour) figure en annexe D du mémoire.

## Comptes de démonstration

| Rôle | Nom | Identifiant | Mot de passe |
|---|---|---|---|
| Formateur (IDOSR201, IDOSR202, IDOSR205 — M201, M204, M205) | Mourad Elaloui | `m.elaloui` | `Formateur@2026` |
| Formateur (IDOSR201, IDOSR202, IDOSR204 — M202, M203) | Youness Chakir | `y.chakir` | `Youness#Ntic2026` |
| Formatrice (IDOCS — M201, M202, M203) | Zineb Nadifi | `z.nadifi` | `Zineb#Ntic2026` |
| Formatrice (ID101, ID102, ID103 — M103, M104) | Jamila | `jamila` | `Jamila#Ntic2026` |
| Gestionnaire des stagiaires (absences et justificatifs) | El Mehdi Talil | `e.talil` | `Gestion@2026` |
| Directrice (validation finale) | Widad Jakjoud | `w.jakjoud` | `Directeur@2026` |
| Administrateur | DR | `admin.dr` | `Admin@2026` |
| Nouveau formateur (enrôlement MFA + changement de mot de passe imposé) | Nouveau Formateur | `nouveau.formateur` | `Bienvenue#2026` |
| Stagiaire (IDOSR201) — identifiant = CEF | Yassine Hilali | `2026001` | `Stagiaire@2026` |
| Stagiaire (ID101) — identifiant = CEF | Taha Hilali | `2026070` | `Stagiaire@2026` |
| Parent (père de Yassine et de Taha) | M. Hilali | `parent.hilali` | `Parent@2026` |

Les comptes Stagiaire et Parent sont créés automatiquement au premier démarrage de cette version, **y compris sur une base existante** (les noms affichés au démarrage dans `docker compose logs app`).

## Circuits et rôles

| Objet | Saisie | Validation | Suivi |
|---|---|---|---|
| Notes | Formateur (saisie puis soumission) | Directrice (valide ou renvoie avec motif) | — |
| Séances (contenu + absents) | Formateur | Directrice (rend les absences officielles) | — |
| Absences | Issues des séances validées | — | Gestionnaire des stagiaires : enregistre ou retire les justificatifs (motif, commentaire chiffré) |

Le gestionnaire des stagiaires n'a **aucun accès aux notes ni à la validation des séances** : il gère uniquement les absences
(tableau de bord d'assiduité, « Absences et justificatifs », journal limité aux absences).
Lors de la mise à jour, les notes et séances qui étaient « contrôlées » repassent automatiquement « en attente de la direction ».

## Espaces Stagiaire et Parent

| Espace | Ce qui est visible | Protections |
|---|---|---|
| **Stagiaire** — « Mes notes », « Mes absences » | Ses notes **validées par la direction** par module (CC1, CC2, CC3, EFM), moyenne indicative, absences des séances validées, notifications | Le dossier est déterminé par la session (aucun identifiant dans l'adresse) ; une évaluation encore dans le circuit apparaît « En validation » **sans sa valeur** |
| **Parent / tuteur** — « Suivi de mes enfants » | Les mêmes informations pour chaque stagiaire rattaché à son compte | Rattachement fait **uniquement par l'administrateur** ; toute tentative sur un autre stagiaire est refusée, tracée « ACCÈS REFUSÉ » et alimente la règle de détection |

- **Notifications** : à la validation finale d'un lot de notes, le stagiaire et ses parents sont prévenus (« Nouvelle note publiée »), sans la note dans le message ; à la validation d'une séance, chaque stagiaire absent et ses parents sont prévenus.
- **Minimisation des données (loi 09-08)** : ni CIN, ni téléphone, ni date de naissance ne sont transmis à ces espaces. Chaque consultation est inscrite au journal d'audit (« Consultation d'un dossier stagiaire »).
- **Mêmes protections que le personnel** : vérification en deux étapes obligatoire, verrouillage après 5 échecs, mot de passe provisoire à changer à la première connexion. La règle « connexion hors plage horaire » ne s'applique pas à ces comptes (consultation le soir et le week-end).
- **Création** : Administrateur → Comptes et rôles → « + Créer un compte » → rôle Stagiaire ou Parent / tuteur → rechercher le dossier (CEF, nom ou groupe). D'autres enfants se rattachent ensuite par Actions → « Rattacher un stagiaire ».

## Mise à jour d'une installation existante

Remplacez le dossier `app` (et ce README) par ceux de cette version, puis relancez `lancer-secure-enote.bat` (ou `docker compose up -d --build`). La base est mise à niveau automatiquement : toutes les notes, séances et l'historique du journal sont conservés.

Le **mode démonstration** (`DEMO_MODE=true`) affiche à l'écran le code TOTP attendu, pour la présentation au jury.
Pour une utilisation réelle, scannez le QR code avec Google Authenticator / Microsoft Authenticator et lancez :
`DEMO_MODE=false docker compose up -d` (PowerShell : `$env:DEMO_MODE="false"; docker compose up -d`).

Si un code TOTP vient d'être utilisé, attendez le code suivant (30 s) : la réutilisation d'un code est volontairement refusée (anti-rejeu).

## Architecture

```
Navigateur ──HTTPS (TLS 1.2/1.3)──► proxy (Nginx, limitation de débit)
                                       │ réseau « frontend »
                                       ▼
                                  app (Node.js 22, sans dépendance npm)
                                   ├─ MFA TOTP (RFC 6238) + QR code d'enrôlement
                                   ├─ RBAC 6 rôles (dont stagiaire et parent) + contrôle de périmètre côté serveur
                                   ├─ AES-256-GCM (HKDF) sur notes, contenus, CIN, secrets MFA
                                   ├─ Journal d'audit chaîné SHA-256 + vérification périodique
                                   ├─ Moteur de détection (8 règles dont z-score)
                                   └─ Sauvegardes chiffrées toutes les 4 h + vérification
                                       │ réseau « backend » (interne, non exposé)
                                       ▼
                                  db (PostgreSQL 16) — compte applicatif à privilèges minimaux,
                                  journal en ajout seul (déclencheur)
```

Les secrets (mots de passe PostgreSQL, clé maîtresse de chiffrement) sont dans `secrets/` et transmis aux conteneurs comme **secrets Docker** ; ils ne sont jamais stockés en base. Ils ont été générés aléatoirement pour cette installation : conservez-les (sans la clé maîtresse, les notes chiffrées et les sauvegardes sont illisibles).

## Scénarios de démonstration (chapitre 26 du mémoire)

| N° | Manipulation | Résultat attendu |
|---|---|---|
| T1 | Se connecter avec le bon mot de passe et un code MFA faux | « Code de vérification invalide ou expiré » |
| T2 | 5 mauvais mots de passe sur `z.nadifi` | Compte verrouillé 15 min + alerte critique |
| T3/T4 | Un formateur appelle une API de validation / du journal | 403 + entrée « ACCÈS REFUSÉ » au journal + alerte critique après 3 refus |
| T5 | Modifier une ligne de `journal_audit` directement en base, puis « Vérifier l'intégrité » | Rupture de chaîne détectée à l'entrée modifiée + alerte critique |
| T6 | Règles de détection → réduire la plage horaire, puis se connecter | Alerte « connexion hors plage » |
| T7 | Abaisser le seuil « volume anormal » puis enregistrer une feuille de notes | Alerte « volume anormal » |

Falsification du journal (T5), depuis PowerShell :

```powershell
docker compose exec db psql -U enote_owner -d enote -c "ALTER TABLE journal_audit DISABLE TRIGGER trg_journal_append_only; UPDATE journal_audit SET acteur_login='pirate' WHERE id=30; ALTER TABLE journal_audit ENABLE TRIGGER trg_journal_append_only;"
```

## Commandes utiles

```powershell
docker compose logs -f app                                    # journaux applicatifs
docker compose exec app node src/cli.js verifier-journal      # intégrité du journal
docker compose exec app node src/cli.js sauvegarder           # sauvegarde immédiate
docker compose exec app node src/cli.js test-restauration     # restauration chronométrée (RTO)
docker compose exec app npm test                              # 33 tests automatisés
```

⚠️ `npm test` exécute les scénarios d'attaque sur l'instance en cours (le test T5 falsifie volontairement le journal). Lancez-le sur une instance de test, puis `docker compose down -v` pour repartir d'une base propre.

## Structure du code

```
app/src/server.js            serveur HTTP, en-têtes de sécurité, gestion centralisée des erreurs
app/src/lib/pg.js            client PostgreSQL (SCRAM-SHA-256, requêtes paramétrées)
app/src/lib/qr.js            générateur de QR code (enrôlement MFA)
app/src/security/            totp.js, password.js, crypto.js, rbac.js, audit.js, anomaly.js
app/src/routes/              auth, notes, seances, admin, suivi (espaces stagiaire et parent)
app/src/services/backup.js   sauvegardes chiffrées et vérification
app/src/db/                  schéma, migrations (moindre privilège), données de démonstration
app/public/                  interface (HTML/CSS/JS, politique CSP stricte)
app/tests/                   tests unitaires et scénarios T1–T7
```

Prototype de recherche : les noms des stagiaires sont fictifs.
