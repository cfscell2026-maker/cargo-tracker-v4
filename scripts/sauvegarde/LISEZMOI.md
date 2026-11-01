# Sauvegarde nocturne

Chaque nuit à **03:00 GMT** (03:00 à Lomé), GitHub :

1. exporte la base de production (données métier, schéma `securite` du journal
   d'audit, comptes de connexion) ;
2. la **chiffre** (AES-256) avec le mot de passe de sauvegarde ;
3. garde le fichier chiffré **30 jours** sur GitHub, hors de Supabase ;
4. envoie un **compte rendu par mail** : réussi ou échec, taille, nombre de
   dossiers, d'engagements, de conteneurs… Le fichier chiffré y est joint s'il
   fait moins de 20 Mo.

La tâche : `.github/workflows/sauvegarde-nocturne.yml`.

> ⚠ **Le dépôt GitHub est public.** Les journaux d'exécution se lisent par
> tous : la tâche n'y écrit rien de lisible, et le fichier gardé est chiffré.
> Rendre le dépôt privé (GitHub → Settings → General → Danger Zone → Change
> visibility) reste préférable.

---

## Mise en route (une seule fois)

Dans GitHub : **Settings → Secrets and variables → Actions → New repository
secret**, créer ces secrets. Personne d'autre que vous ne doit les saisir.

| Secret | Valeur |
|---|---|
| `SAUVEGARDE_DB_URL` | Adresse de connexion à la base, **Session pooler** (voir ci-dessous) |
| `SAUVEGARDE_MOT_DE_PASSE` | Mot de passe de chiffrement, **16 caractères minimum**. À noter en lieu sûr : sans lui, aucune sauvegarde ne se restaure. |
| `SMTP_SERVEUR` | `smtp.gmail.com` (Gmail) ou `smtp.resend.com` (Resend) |
| `SMTP_PORT` | `465` |
| `SMTP_UTILISATEUR` | L'adresse Gmail d'envoi (ou `resend` pour Resend) |
| `SMTP_MOT_DE_PASSE` | Le **mot de passe d'application** Gmail (ou la clé d'API Resend) |
| `MAIL_DESTINATAIRE` | Qui reçoit le compte rendu (plusieurs adresses : séparées par des virgules) |
| `MAIL_EXPEDITEUR` | Facultatif. Par défaut, `SMTP_UTILISATEUR`. |

### L'adresse de la base
Supabase → bouton **Connect** (en haut) → **Session pooler** → copier l'URI, et
remplacer `[YOUR-PASSWORD]` par le mot de passe de la base. Elle ressemble à :

```
postgresql://postgres.hwutqjlbzfcjfxvnugnx:MOT_DE_PASSE@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
```

Prendre le **Session pooler**, pas la « Direct connection » : les machines de
GitHub ne joignent pas l'adresse directe (IPv6 seulement).

### Le mot de passe d'application Gmail
Le compte Gmail d'envoi doit avoir la **validation en deux étapes** activée.
Puis : myaccount.google.com → Sécurité → **Mots de passe des applications** →
créer « Sauvegarde CARGO TRACKER » → copier les 16 lettres dans
`SMTP_MOT_DE_PASSE`. Ce n'est pas le mot de passe du compte, et il se révoque
à tout moment.

### Premier essai
GitHub → **Actions** → **Sauvegarde nocturne** → **Run workflow**. Le mail
arrive en quelques minutes ; ensuite, la tâche tourne seule chaque nuit.

---

## Restaurer une sauvegarde

Il faut le client PostgreSQL 17 (`pg_restore`) et `gpg` (fourni avec Git pour
Windows, dans « Git Bash »).

1. **Récupérer le fichier** `cargo-tracker_AAAA-MM-JJ.tar.gpg` : pièce jointe
   du mail, ou GitHub → Actions → l'exécution de la nuit voulue → *Artifacts*.
2. **Déchiffrer et ouvrir** (le mot de passe de sauvegarde est demandé) :
   ```bash
   gpg --output sauvegarde.tar --decrypt cargo-tracker_AAAA-MM-JJ.tar.gpg
   tar -xf sauvegarde.tar
   ```
   On obtient `base_AAAA-MM-JJ.dump` et, normalement, `comptes_AAAA-MM-JJ.dump`.
3. **Restaurer dans un projet Supabase neuf**, jamais par-dessus la production :
   ```bash
   pg_restore --no-owner --no-privileges --dbname "<adresse du projet neuf>" base_AAAA-MM-JJ.dump
   pg_restore --data-only --dbname "<adresse du projet neuf>" comptes_AAAA-MM-JJ.dump
   ```
   Un message « schema "public" already exists » est normal.
4. **Vérifier** que les comptages du projet neuf correspondent à ceux du mail
   de la nuit restaurée.

**Une sauvegarde jamais restaurée n'est pas une sauvegarde** : faire l'essai de
restauration complet une fois par trimestre (voir `EXPLOITATION.md`, § 4).
