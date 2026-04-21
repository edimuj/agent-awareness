#!/bin/bash
# Install npm dependencies to CLAUDE_PLUGIN_DATA (survives plugin updates)
diff -q "${CLAUDE_PLUGIN_ROOT}/package.json" "${CLAUDE_PLUGIN_DATA}/package.json" \
  >/dev/null 2>&1 || \
  (cp "${CLAUDE_PLUGIN_ROOT}/package.json" "${CLAUDE_PLUGIN_DATA}/" && \
   cd "${CLAUDE_PLUGIN_DATA}" && \
   npm install --production --ignore-scripts 2>/dev/null) || \
  rm -f "${CLAUDE_PLUGIN_DATA}/package.json"
