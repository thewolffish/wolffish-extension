import '@src/index.css';
import Options from '@src/Options';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Options />);
}
