# Fichiers publics — apps/web/public/

Tout ce qui est déposé ici est servi **à la racine du site** : `public/logo.png`
devient `/logo.png` dans le navigateur. Ces fichiers ne passent pas par la
compilation — ils sont copiés tels quels dans `dist/`.

## `logo.png` — le logo de l'application

**À déposer ici sous le nom exact `logo.png`.**

Il est référencé à trois endroits, tous déjà en place :

| Où | Rôle |
|---|---|
| `index.html` — `<link rel="icon">` | Icône de l'onglet du navigateur |
| `index.html` — `<link rel="apple-touch-icon">` | Icône sur l'écran d'accueil iOS |
| `App.tsx` | Barre latérale (38 px) et écran de connexion (96 px) |

Tant que le fichier est absent, l'image se masque d'elle-même (`onError`) et
seul le nom s'affiche : aucune icône cassée à l'écran.

### Format attendu

- **PNG carré**, idéalement 512 × 512 px
- **Fond blanc ou transparent** — le cadre rond est blanc
- Le logo est affiché en `object-fit: contain` : il est inscrit **en entier**
  dans le cercle, jamais recadré (voir `.logo-rond` dans `src/styles.css`)

### Pourquoi un carré, alors que l'affichage est rond ?

Le CSS se charge de l'arrondi. Fournir une image déjà découpée en rond
donnerait des bords crénelés sur les écrans à forte densité, et une icône
d'onglet mal cadrée — la plupart des systèmes appliquent leur propre masque.
