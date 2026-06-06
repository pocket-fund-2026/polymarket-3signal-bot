#!/bin/bash
# Live simulation dashboard — run this in a separate terminal
# Shows last trades + current capital in real time

clear_line() { printf '\r\033[K'; }

while true; do
  clear
  echo "╔══════════════════════════════════════════════════════════════════════╗"
  echo "║          POLYMARKET 120-MIN SIMULATION — LIVE DASHBOARD             ║"
  echo "╚══════════════════════════════════════════════════════════════════════╝"
  echo ""

  # Extract key stats from log
  LOG=/tmp/sim-120.log

  # Latest heartbeat line
  HEARTBEAT=$(grep "⏱" "$LOG" 2>/dev/null | tail -1)
  CAP=$(echo "$HEARTBEAT" | grep -oP 'cap=\$[\d.]+' | head -1)
  PNL=$(echo "$HEARTBEAT" | grep -oP 'P&L [+$\d.-]+' | head -1)
  WL=$(echo "$HEARTBEAT" | grep -oP 'W=\d+ L=\d+' | head -1)
  PENDING=$(echo "$HEARTBEAT" | grep -oP 'pending=\d+' | head -1)
  TIME_LEFT=$(echo "$HEARTBEAT" | grep -oP '\d+m left' | head -1)
  ELAPSED=$(echo "$HEARTBEAT" | grep -oP 'T\+\d+m' | head -1)

  echo "  Time:     ${ELAPSED} elapsed | ${TIME_LEFT}"
  echo "  Capital:  ${CAP:-\$3.00}"
  echo "  P&L:      ${PNL:-+\$0.00}"
  echo "  Record:   ${WL:-W=0 L=0} | ${PENDING:-pending=0}"
  echo ""
  echo "──────────────────────────────────────────────────────────────────────"
  echo "  RECENT TRADES:"
  echo ""

  # Show last 10 trade/resolution lines
  grep -E "ENTRY|RESOLVED|SETTLED|ARB" "$LOG" 2>/dev/null | tail -10 | while IFS= read -r line; do
    if echo "$line" | grep -q "✅"; then
      printf "  \033[32m%s\033[0m\n" "$line"
    elif echo "$line" | grep -q "❌"; then
      printf "  \033[31m%s\033[0m\n" "$line"
    elif echo "$line" | grep -q "💎"; then
      printf "  \033[33m%s\033[0m\n" "$line"
    elif echo "$line" | grep -q "⚡"; then
      printf "  \033[36m%s\033[0m\n" "$line"
    else
      echo "  $line"
    fi
  done

  echo ""
  echo "──────────────────────────────────────────────────────────────────────"
  echo "  LAST LOG LINES:"
  echo ""
  tail -8 "$LOG" 2>/dev/null | sed 's/^/  /'
  echo ""
  echo "  [Refreshes every 3s] Log: /tmp/sim-120.log"
  echo ""

  sleep 3
done
