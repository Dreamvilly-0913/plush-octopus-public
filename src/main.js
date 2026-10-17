import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource-variable/inter/wght.css';
import './style.css';
import { App } from './app.js';

const canvas = document.getElementById('scene');
try {
  new App(canvas);
} catch (err) {
  console.error(err);
  const msg = document.createElement('p');
  msg.textContent = 'This study needs WebGL2. ' + (err && err.message ? err.message : '');
  msg.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);font:italic 16px Georgia,serif;color:#4a443e';
  document.body.appendChild(msg);
}
