"""Tests du compte rendu de sauvegarde : `python scripts/sauvegarde/test_compte_rendu.py`."""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import compte_rendu as cr  # noqa: E402

NUIT = datetime(2026, 11, 2, 3, 4, tzinfo=timezone.utc)


class CompteRendu(unittest.TestCase):
    def setUp(self):
        self.dossier = tempfile.TemporaryDirectory()
        d = Path(self.dossier.name)
        self.fichier = d / 'cargo-tracker_2026-11-02.tar.gpg'
        self.fichier.write_bytes(b'x' * 300_000)
        self.comptages = d / 'comptages.txt'
        self.comptages.write_text('Dossiers (cargaisons)|22140\nEngagements en cours|205\nTaille de la base|612 MB\n', encoding='utf-8')
        self.env = {
            'STATUT': 'success', 'FICHIER': str(self.fichier), 'COMPTES': 'ok', 'COMPTAGES': str(self.comptages),
            'LIEN_EXECUTION': 'https://github.com/o/r/actions/runs/1',
            'SMTP_SERVEUR': 'smtp.exemple.test', 'SMTP_UTILISATEUR': 'envoi@exemple.test', 'SMTP_MOT_DE_PASSE': 'x',
            'MAIL_DESTINATAIRE': 'a@exemple.test, b@exemple.test',
        }

    def tearDown(self):
        self.dossier.cleanup()

    def test_reussite_avec_piece_jointe_et_comptages(self):
        m = cr.construire(self.env, NUIT)
        self.assertIn('✅', m['Subject'])
        self.assertIn('02/11/2026', m['Subject'])
        self.assertEqual(m['To'], 'a@exemple.test, b@exemple.test')
        corps = m.get_body(('plain',)).get_content()
        self.assertIn('Il est joint à ce mail.', corps)
        self.assertIn('Engagements en cours', corps)
        self.assertIn('22140', corps)
        pj = [p.get_filename() for p in m.iter_attachments()]
        self.assertEqual(pj, ['cargo-tracker_2026-11-02.tar.gpg'])

    def test_trop_gros_pour_le_mail(self):
        m = cr.construire({**self.env, 'JOINDRE_MAX_MO': '0.1'}, NUIT)
        self.assertEqual(list(m.iter_attachments()), [])
        self.assertIn("n'est pas joint", m.get_body(('plain',)).get_content())

    def test_echec_sans_piece_jointe(self):
        m = cr.construire({**self.env, 'STATUT': 'failure', 'FICHIER': ''}, NUIT)
        self.assertIn('ÉCHEC', m['Subject'])
        self.assertEqual(list(m.iter_attachments()), [])
        self.assertIn('Re-run jobs', m.get_body(('plain',)).get_content())

    def test_statut_reussi_mais_fichier_absent_est_un_echec(self):
        m = cr.construire({**self.env, 'FICHIER': str(self.fichier) + '.absent'}, NUIT)
        self.assertIn('ÉCHEC', m['Subject'])

    def test_comptes_de_connexion_non_exportes_signales(self):
        m = cr.construire({**self.env, 'COMPTES': 'echec'}, NUIT)
        self.assertIn('COMPTES DE CONNEXION', m.get_body(('plain',)).get_content())

    def test_envoi_ssl_465_et_starttls_587(self):
        m = cr.construire(self.env, NUIT)
        with mock.patch.object(cr.smtplib, 'SMTP_SSL') as ssl_, mock.patch.object(cr.smtplib, 'SMTP') as tls:
            cr.envoyer(m, self.env)
            ssl_.assert_called_once()
            ssl_.return_value.__enter__.return_value.login.assert_called_once_with('envoi@exemple.test', 'x')
            cr.envoyer(m, {**self.env, 'SMTP_PORT': '587'})
            tls.return_value.__enter__.return_value.starttls.assert_called_once()

    def test_reglages_absents_refus_clair_sans_envoi(self):
        with mock.patch.dict(os.environ, {'SMTP_SERVEUR': ''}, clear=True), \
             mock.patch.object(cr, 'envoyer') as env_:
            self.assertEqual(cr.main(), 1)
            env_.assert_not_called()


if __name__ == '__main__':
    unittest.main()
