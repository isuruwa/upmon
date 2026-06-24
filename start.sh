#!/bin/bash
rm -rf /root/upmon/data/upmon.db.lock
rm -f /root/upmon/data/upmon.db-shm
rm -f /root/upmon/data/upmon.db-wal
sleep 1
exec node /root/upmon/server.js
