// Inicialización de Firebase (SDK modular desde CDN, sin paso de compilación).
import { firebaseConfig, isConfigured } from './firebase-config.js';

const VERSION = '10.14.1';
export const configured = isConfigured();

let fb = null;
if (configured) {
  const base = `https://www.gstatic.com/firebasejs/${VERSION}`;
  const [appM, authM, fsM] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-firestore.js`),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  // Caché persistente: la app sigue funcionando sin conexión y sincroniza al volver.
  const db = fsM.initializeFirestore(app, {
    localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }),
  });
  fb = { auth, db, ...authM, ...fsM };
}

export { fb };
