#!/bin/bash
# Probe a URL. Emits: URL <TAB> code <TAB> location <TAB> size <TAB> title
u="$1"
out=$(curl -sS --max-time 20 -o /tmp/pb.$$ -D /tmp/ph.$$ -w '%{http_code}\t%{size_download}' "$u" 2>/dev/null)
code=$(echo "$out" | cut -f1); size=$(echo "$out" | cut -f2)
loc=$(grep -i '^location:' /tmp/ph.$$ | tail -1 | tr -d '\r' | sed 's/^[Ll]ocation: *//')
title=$(tr -d '\r\n' < /tmp/pb.$$ | grep -o '<title>[^<]*</title>' | head -1 | sed 's/<[^>]*>//g')
printf '%s\t%s\t%s\t%s\t%s\n' "$u" "$code" "$loc" "$size" "$title"
rm -f /tmp/pb.$$ /tmp/ph.$$
