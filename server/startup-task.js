// Moved to server/install/startup-task.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./install/startup-task.js');
