const { createId, isId } = require('./entity-id');

function createUserId() {
  return createId('users');
}

function isUserId(value) {
  return isId('users', value);
}

module.exports = { createUserId, isUserId };
