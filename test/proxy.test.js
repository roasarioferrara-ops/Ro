'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const L = require('../lib');

test('Bekannte Proxys: private Netze und Cloudflare', () => {
  assert.equal(L.isKnownProxy('10.1.2.3'), true);
  assert.equal(L.isKnownProxy('::ffff:10.1.2.3'), true);
  assert.equal(L.isKnownProxy('104.16.1.1'), true);
  assert.equal(L.isKnownProxy('2606:4700::1'), true);
  assert.equal(L.isKnownProxy('8.8.8.8'), false);
  assert.equal(L.isKnownProxy('2001:db8::1'), false);
  assert.equal(L.isKnownProxy('kein-ip'), false);
});

test('Echte Besucher-Adresse hinter dem Hoster, nicht fälschbar', async (t) => {
  const app = express();
  app.set('trust proxy', L.trustHostingProxies);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const ipFor = async (xff) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/ip`, {
      headers: xff ? { 'X-Forwarded-For': xff } : {},
    });
    return (await res.json()).ip;
  };

  // Ein Proxy beim Hoster
  assert.equal(await ipFor('203.0.113.5'), '203.0.113.5');
  // Besucher schickt selbst eine falsche Angabe mit → wird ignoriert
  assert.equal(await ipFor('198.51.100.7, 203.0.113.5'), '203.0.113.5');
  // Render: Cloudflare → Render → App
  assert.equal(await ipFor('198.51.100.7, 203.0.113.5, 104.16.1.1'), '203.0.113.5');
  assert.equal(await ipFor('2001:db8::1, 2606:4700::1'), '2001:db8::1');
  // Höchstens ein Cloudflare-Proxy wird übersprungen
  assert.equal(await ipFor('198.51.100.7, 104.28.1.1, 104.16.1.1'), '104.28.1.1');
});
