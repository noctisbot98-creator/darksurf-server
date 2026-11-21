// Grille de forfaits identique à celle de Geny. Prix = prix payé par le vendeur, en crédits (1 crédit = 100 F).
// Tous : 1 appareil par clé, débit illimité (aucun bridage de vitesse).
const GENY_PLANS = [
  { name: 'Pass Test', hours: 2, unlimited: true, credits: 0, limit: 3 },
  { name: 'Pass Flash', hours: 24, quotaGb: 1, credits: 1 },
  { name: 'Nuit Blanche', hours: 24, quotaGb: 5, credits: 2, window: '00:00-06:00' },
  { name: 'Pass Journée', hours: 24, quotaGb: 2.5, credits: 2.5 },
  { name: 'Pass Week-end', hours: 72, quotaGb: 5, credits: 5 },
  { name: 'Pass Semaine Éco', hours: 168, quotaGb: 4, credits: 5 },
  { name: 'Pass Semaine Max', hours: 168, quotaGb: 10, credits: 10 },
  { name: 'Pass Mensuel Découverte', hours: 720, quotaGb: 25, credits: 25 },
  { name: 'Pass Mensuel Standard', hours: 720, quotaGb: 60, credits: 50 },
  { name: 'Pass Semaine Illimité', hours: 168, unlimited: true, credits: 20 },
  { name: 'Pass 2 Semaines Illimité', hours: 336, unlimited: true, credits: 36 },
  { name: 'Pass Mensuel Maxi', hours: 720, unlimited: true, credits: 80 },
];
module.exports = { GENY_PLANS };
