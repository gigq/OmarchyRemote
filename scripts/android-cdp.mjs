// Inspect a debug Android WebView forwarded with adb forward tcp:9225 localabstract:webview_devtools_remote_<pid>.
import WebSocket from 'ws';
const endpoint = process.env.ANDROID_CDP_URL || 'http://127.0.0.1:9225';
const targets = await (await fetch(endpoint + '/json/list')).json();
const target = targets.find(t => t.url.includes('/native/') || t.url.includes('/assets/Web/'));
if (!target) throw Error('No Omarchy Remote shell WebView is attached');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});
try {
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('WebView evaluation timed out')), 15000);
    socket.on('message', data => {
      const reply = JSON.parse(data);
      if (reply.id !== 1) return;
      clearTimeout(timer);
      if (reply.error) reject(Error(reply.error.message));
      else resolve(reply.result);
    });
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: process.argv[2] || 'document.title',
        returnByValue: true,
        awaitPromise: true,
      },
    })
  );
  console.log(JSON.stringify(await response, null, 2));
} finally {
  socket.close();
}
