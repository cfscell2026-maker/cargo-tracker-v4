"""
Compte rendu de la sauvegarde nocturne, par mail (2026-11-01).

Lancé par .github/workflows/sauvegarde-nocturne.yml, que la sauvegarde ait
réussi ou non : un matin sans mail doit inquiéter, un mail « ÉCHEC » aussi.

Bibliothèque standard seulement (smtplib) : aucune dépendance à installer, ni
d'action tierce à qui confier le mot de passe du compte d'envoi.

Variables d'environnement :
  STATUT              success | failure | cancelled (statut de la tâche)
  FICHIER             chemin du fichier chiffré (vide si l'export a échoué)
  COMPTES             ok | echec (export des comptes de connexion)
  COMPTAGES           fichier « libellé|valeur » produit par comptages.sql
  LIEN_EXECUTION      lien vers l'exécution GitHub (téléchargement de la sauvegarde)
  SMTP_SERVEUR, SMTP_PORT (465 = SSL, 587 = STARTTLS ; 465 par défaut),
  SMTP_UTILISATEUR, SMTP_MOT_DE_PASSE,
  MAIL_EXPEDITEUR (par défaut SMTP_UTILISATEUR), MAIL_DESTINATAIRE (virgules)
  JOINDRE_MAX_MO      taille maximale de la pièce jointe (20 par défaut)

N'écrit JAMAIS de comptage ni de donnée sur la sortie : le dépôt est public,
et le journal d'exécution avec lui.
"""
from __future__ import annotations

import os
import smtplib
import ssl
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path


def lire_comptages(chemin: str) -> list[tuple[str, str]]:
    p = Path(chemin) if chemin else None
    if not p or not p.is_file():
        return []
    lignes = []
    for brute in p.read_text(encoding='utf-8').splitlines():
        if '|' in brute:
            libelle, valeur = brute.split('|', 1)
            lignes.append((libelle.strip(), valeur.strip()))
    return lignes


def taille_lisible(octets: int) -> str:
    mo = octets / (1024 * 1024)
    return f'{mo:.1f} Mo'.replace('.', ',') if mo >= 0.1 else f'{octets // 1024} Ko'


def construire(env: dict[str, str], maintenant: datetime | None = None) -> EmailMessage:
    """Le message, sans l'envoyer (testable)."""
    maintenant = maintenant or datetime.now(timezone.utc)
    jour = maintenant.strftime('%d/%m/%Y')
    statut = env.get('STATUT', '')
    fichier = Path(env['FICHIER']) if env.get('FICHIER') else None
    present = bool(fichier and fichier.is_file())
    reussi = statut == 'success' and present
    taille = fichier.stat().st_size if present else 0
    max_mo = float(env.get('JOINDRE_MAX_MO') or 20)
    joindre = reussi and taille <= max_mo * 1024 * 1024
    lien = env.get('LIEN_EXECUTION', '')
    comptages = lire_comptages(env.get('COMPTAGES', ''))

    msg = EmailMessage()
    if reussi:
        msg['Subject'] = f'✅ Sauvegarde CARGO TRACKER du {jour} : réussie ({taille_lisible(taille)})'
    else:
        msg['Subject'] = f'❌ Sauvegarde CARGO TRACKER du {jour} : ÉCHEC'
    msg['From'] = env.get('MAIL_EXPEDITEUR') or env.get('SMTP_UTILISATEUR', '')
    msg['To'] = ', '.join(a.strip() for a in env.get('MAIL_DESTINATAIRE', '').split(',') if a.strip())

    l: list[str] = []
    if reussi:
        l.append(f'La sauvegarde de cette nuit ({maintenant.strftime("%H:%M")} GMT) a réussi.')
        l.append('')
        l.append(f'Fichier chiffré : {fichier.name} ({taille_lisible(taille)})')
        if joindre:
            l.append('Il est joint à ce mail.')
        else:
            l.append(f'Il dépasse {int(max_mo)} Mo : il n\'est pas joint, téléchargez-le depuis GitHub (lien plus bas).')
        l.append('Une copie est gardée 30 jours sur GitHub.')
        if env.get('COMPTES') != 'ok':
            l.append('')
            l.append('⚠ Les COMPTES DE CONNEXION n\'ont pas pu être exportés cette nuit (les données métier, si).')
    else:
        l.append('⚠ La sauvegarde de cette nuit a ÉCHOUÉ. Aucune copie n\'a été faite.')
        l.append('Ouvrez le lien plus bas pour voir l\'étape en erreur, puis relancez-la avec « Re-run jobs ».')
    if comptages:
        l.append('')
        l.append('Contenu de la base au moment de la sauvegarde :')
        largeur = max(len(c[0]) for c in comptages)
        for libelle, valeur in comptages:
            l.append(f'  {libelle.ljust(largeur)}  {valeur}')
    if lien:
        l.append('')
        l.append(f'Détail et téléchargement : {lien}')
    l.append('')
    l.append('Le fichier ne s\'ouvre qu\'avec le mot de passe de sauvegarde.')
    l.append('Restauration : scripts/sauvegarde/LISEZMOI.md')
    msg.set_content('\n'.join(l))

    if joindre:
        msg.add_attachment(fichier.read_bytes(), maintype='application', subtype='octet-stream', filename=fichier.name)
    return msg


def envoyer(msg: EmailMessage, env: dict[str, str]) -> None:
    serveur = env['SMTP_SERVEUR']
    port = int(env.get('SMTP_PORT') or 465)
    contexte = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(serveur, port, context=contexte, timeout=60) as s:
            s.login(env['SMTP_UTILISATEUR'], env['SMTP_MOT_DE_PASSE'])
            s.send_message(msg)
    else:
        with smtplib.SMTP(serveur, port, timeout=60) as s:
            s.starttls(context=contexte)
            s.login(env['SMTP_UTILISATEUR'], env['SMTP_MOT_DE_PASSE'])
            s.send_message(msg)


def main() -> int:
    env = dict(os.environ)
    manque = [v for v in ('SMTP_SERVEUR', 'SMTP_UTILISATEUR', 'SMTP_MOT_DE_PASSE', 'MAIL_DESTINATAIRE') if not env.get(v)]
    if manque:
        print('::error::Réglages mail absents : ' + ', '.join(manque) + ' (voir scripts/sauvegarde/LISEZMOI.md)')
        return 1
    msg = construire(env)
    envoyer(msg, env)
    print('Compte rendu envoyé.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
