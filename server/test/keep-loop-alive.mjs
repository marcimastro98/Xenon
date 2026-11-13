// Import this in a test file that awaits a timer the app made.
//
// The app unrefs its timers on purpose, so none of them keeps the server from
// shutting down. A test that awaits one therefore holds nothing open, and on
// Node 22 the test runner lets the process end there: that test and every one
// after it in the file come back "cancelled" with "Promise resolution is still
// pending but the event loop has already resolved". Node 24 and later keep the
// process alive until every test has ended; this does the same on every
// version, so a file behaves alike on all three lines `engines` accepts.
import { after } from 'node:test';

const hold = setInterval(() => {}, 2 ** 30);
after(() => clearInterval(hold));
