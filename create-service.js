const fs = require('fs');
const https = require('https');
const body = fs.readFileSync('C:\\Users\\Alok Mishra\\Downloads\\zitadel-test\\zitadel-test\\zitadel-create.json');
const opts = {
  hostname: 'api.render.com',
  path: '/v1/services',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer rnd_cUnLrZ7PloFG8eeazsubD9ccLSBO',
    'Content-Type': 'application/json',
    'Content-Length': body.length
  }
};
const req = https.request(opts, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log(d));
});
req.on('error', e => console.error(e));
req.write(body);
req.end();
