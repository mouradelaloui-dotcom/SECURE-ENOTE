'use strict';
/**
 * Contrôle d'accès basé sur les rôles (H1) — matrice centralisée.
 * Toute route de l'API déclare la permission requise ; la vérification a lieu
 * côté serveur, l'interface ne fait que masquer ce qui n'est pas autorisé.
 * Séparation des tâches (ISO/IEC 27002 §5.3) : celui qui saisit ne valide pas,
 * l'administrateur technique ne valide pas.
 * Circuits : notes et séances suivent formateur (saisie, soumission) -> directrice (validation).
 * Le gestionnaire des stagiaires gère uniquement les absences : suivi de l'assiduité et
 * enregistrement des justificatifs. Il n'a aucun accès aux notes ni à la validation des séances.
 * Les stagiaires et les parents n'ont qu'un droit de lecture sur leur propre dossier (ou celui de leurs enfants).
 */
const PERMISSIONS = {
  formateur: [
    'note.lire_propres', 'note.saisir', 'note.soumettre',
    'seance.lire_propres', 'seance.saisir', 'seance.soumettre',
  ],
  gestionnaire: [            // gestionnaire des stagiaires : absences uniquement
    'absence.lire', 'absence.justifier',
    'journal.lire_partiel',
  ],
  directeur: [
    'note.lire_toutes', 'note.valider',
    'seance.lire_toutes', 'seance.valider',
    'journal.lire_partiel', 'export.notes', 'stats.lire', 'securite.synthese',
  ],
  administrateur: [
    'note.lire_toutes', 'note.modifier_apres_validation', 'seance.lire_toutes',
    'journal.lire_complet', 'journal.verifier',
    'comptes.gerer', 'alertes.gerer', 'regles.configurer', 'sauvegardes.gerer',
    'securite.synthese', 'stats.lire',
  ],
  // Espaces de consultation : lecture seule, limitée aux notes VALIDÉES et à l'assiduité.
  // Le dossier consulté est déterminé par le serveur (session), jamais par un identifiant fourni par le client.
  stagiaire: ['dossier.lire_soi'],
  parent: ['dossier.lire_enfants'],
};

const ROLES = Object.keys(PERMISSIONS);

function estAutorise(role, permission) {
  return (PERMISSIONS[role] || []).includes(permission);
}

module.exports = { PERMISSIONS, ROLES, estAutorise };
