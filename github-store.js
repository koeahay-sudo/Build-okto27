const fs = require('fs-extra');
const path = require('path');

const STORE_PATH = './data/github-servers.json';

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) return fs.readJsonSync(STORE_PATH);
  } catch {}
  return { servers: [] };
}

function saveStore(data) {
  fs.ensureDirSync('./data');
  fs.writeJsonSync(STORE_PATH, data, { spaces: 2 });
}

function listServers() {
  return loadStore().servers;
}

function getById(id) {
  return loadStore().servers.find(s => s.id === id) || null;
}

function addServer(name, token, repo) {
  const store = loadStore();
  const server = { id: `srv_${Date.now()}`, name, token, repo };
  store.servers.push(server);
  saveStore(store);
  return server;
}

function updateServer(id, updates) {
  const store = loadStore();
  const idx = store.servers.findIndex(s => s.id === id);
  if (idx === -1) return null;
  store.servers[idx] = { ...store.servers[idx], ...updates };
  saveStore(store);
  return store.servers[idx];
}

function removeServer(id) {
  const store = loadStore();
  store.servers = store.servers.filter(s => s.id !== id);
  saveStore(store);
}

module.exports = { listServers, getById, addServer, updateServer, removeServer };
