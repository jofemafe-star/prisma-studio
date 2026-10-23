// Configuración web del proyecto Firebase "PRISMA-STUDIO".
// Estos valores NO son secretos: la protección real está en firestore.rules.
export const firebaseConfig = {
  apiKey: 'AIzaSyDnj3I-onONHx92gNx06xGMTYhowT1ucK8',
  authDomain: 'prisma-studio-bd9f6.firebaseapp.com',
  projectId: 'prisma-studio-bd9f6',
  storageBucket: 'prisma-studio-bd9f6.firebasestorage.app',
  messagingSenderId: '752078206480',
  appId: '1:752078206480:web:46b394658aed3bbbb8fc95',
};

export const isConfigured = () =>
  Boolean(firebaseConfig.apiKey) && !String(firebaseConfig.apiKey).startsWith('PEGAR');
