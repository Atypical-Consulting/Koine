// Brand typefaces, self-hosted (offline-safe for the Tauri shell) and shared with the docs site:
// Archivo (display / wordmark), Hanken Grotesk (body), JetBrains Mono (code). Bundled by Vite.
import '@fontsource-variable/archivo';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@maxgraph/core/css/common.css';
import '@/styles/main.scss';
import { init } from '@/shell/ide';

window.addEventListener('DOMContentLoaded', () => init());
