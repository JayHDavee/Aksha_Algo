#!/bin/bash

# ============================================================
# Aksha Hourly Monitoring Script
# ============================================================
# Purpose:
#   - Check Internet connectivity
#   - Check local gateway
#   - Check DNS
#   - Check Aksha Docker containers
#   - Record Aksha container network usage (delta since last check)
#   - Record host network usage (delta since last check)
#   - Record CPU, RAM and disk usage
#
# NOTE:
#   No RTSP URLs or camera credentials are required.
#
#   LIMITATION: "network usage" here means total bytes in/out for each
#   container / the host's default-route interface. It is NOT filtered
#   to RTSP traffic specifically — if a container also does other
#   networking (Kafka, API calls, etc.) that's counted too. If any
#   Aksha container runs with --network host, its per-container number
#   will just mirror the host number below, not an isolated figure.
# ============================================================

# -----------------------------
# Configuration
# -----------------------------

LOG_FILE="$HOME/Desktop/aksha_hourly_monitor.log"
STATE_DIR="$HOME/.aksha_monitor_state"
CONTAINER_STATE_FILE="$STATE_DIR/container_net_usage.tsv"
HOST_STATE_FILE="$STATE_DIR/host_net_usage.tsv"

mkdir -p "$HOME/Desktop"
mkdir -p "$STATE_DIR"
touch "$CONTAINER_STATE_FILE" "$HOST_STATE_FILE"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# -----------------------------
# Helpers
# -----------------------------

# Converts docker stats sizes like "12.3MB" / "800kB" / "0B" to raw bytes (decimal/SI units, matching docker's formatter)
parse_size_to_bytes() {
    local val num unit mult
    val="$1"
    num=$(echo "$val" | sed -E 's/^([0-9.]+).*/\1/')
    unit=$(echo "$val" | sed -E 's/^[0-9.]+//')
    case "$unit" in
        B)  mult=1 ;;
        kB) mult=1000 ;;
        MB) mult=1000000 ;;
        GB) mult=1000000000 ;;
        TB) mult=1000000000000 ;;
        *)  mult=1 ;;
    esac
    awk -v n="${num:-0}" -v m="$mult" 'BEGIN{printf "%.0f", n*m}'
}

bytes_to_mb() {
    awk -v b="${1:-0}" 'BEGIN{printf "%.2f", b/1000000}'
}

# -----------------------------
# Start Log
# -----------------------------

{
    echo ""
    echo "============================================================"
    echo "AKSHA HOURLY HEALTH CHECK"
    echo "Time: $TIMESTAMP"
    echo "============================================================"

} >> "$LOG_FILE"


# ============================================================
# 1. INTERNET CONNECTIVITY
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- INTERNET ----------" >> "$LOG_FILE"

if ping -c 3 -W 3 8.8.8.8 >/tmp/aksha_ping.txt 2>&1; then

    echo "Internet : UP" >> "$LOG_FILE"

    LATENCY=$(awk -F'/' '/rtt/ {print $5}' /tmp/aksha_ping.txt)

    if [ -n "$LATENCY" ]; then
        echo "Latency  : ${LATENCY} ms" >> "$LOG_FILE"
    fi

else

    echo "Internet : DOWN" >> "$LOG_FILE"

fi


# ============================================================
# 2. DEFAULT GATEWAY
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- GATEWAY ----------" >> "$LOG_FILE"

GATEWAY=$(ip route | awk '/default/ {print $3; exit}')

if [ -n "$GATEWAY" ]; then

    echo "Gateway  : $GATEWAY" >> "$LOG_FILE"

    if ping -c 2 -W 2 "$GATEWAY" >/dev/null 2>&1; then
        echo "Status   : UP" >> "$LOG_FILE"
    else
        echo "Status   : DOWN" >> "$LOG_FILE"
    fi

else

    echo "Gateway  : NOT FOUND" >> "$LOG_FILE"

fi


# ============================================================
# 3. DNS
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- DNS ----------" >> "$LOG_FILE"

if getent hosts google.com >/dev/null 2>&1; then

    echo "DNS      : OK" >> "$LOG_FILE"

else

    echo "DNS      : FAILED" >> "$LOG_FILE"

fi


# ============================================================
# 4. AKSHA DOCKER CONTAINERS
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- AKSHA CONTAINERS ----------" >> "$LOG_FILE"

if command -v docker >/dev/null 2>&1; then

    AKSHA_CONTAINERS=$(docker ps --format '{{.Names}}' | grep -i aksha)

    if [ -n "$AKSHA_CONTAINERS" ]; then

        docker ps \
            --format 'Container={{.Names}} | Status={{.Status}}' \
            | grep -i aksha >> "$LOG_FILE"

    else

        echo "No running Aksha containers found." >> "$LOG_FILE"

    fi

else

    echo "Docker : NOT INSTALLED / NOT AVAILABLE" >> "$LOG_FILE"

fi


# ============================================================
# 5. AKSHA NETWORK USAGE (per-container, delta since last check)
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- AKSHA NETWORK USAGE (delta since last check) ----------" >> "$LOG_FILE"

if command -v docker >/dev/null 2>&1; then

    AKSHA_CONTAINERS=$(docker ps --format '{{.Names}}' | grep -i aksha)

    if [ -n "$AKSHA_CONTAINERS" ]; then

        NEW_CONTAINER_STATE=$(mktemp)

        for CONTAINER in $AKSHA_CONTAINERS
        do
            NETIO=$(docker stats "$CONTAINER" --no-stream --format '{{.NetIO}}')
            RX_STR=$(echo "$NETIO" | awk -F' / ' '{print $1}')
            TX_STR=$(echo "$NETIO" | awk -F' / ' '{print $2}')
            RX_BYTES=$(parse_size_to_bytes "$RX_STR")
            TX_BYTES=$(parse_size_to_bytes "$TX_STR")

            PREV_LINE=$(grep -P "^${CONTAINER}\t" "$CONTAINER_STATE_FILE" 2>/dev/null)
            PREV_RX=$(echo "$PREV_LINE" | awk -F'\t' '{print $2}')
            PREV_TX=$(echo "$PREV_LINE" | awk -F'\t' '{print $3}')
            PREV_RX=${PREV_RX:-0}
            PREV_TX=${PREV_TX:-0}

            if [ "$RX_BYTES" -lt "$PREV_RX" ] || [ "$TX_BYTES" -lt "$PREV_TX" ]; then
                # Counters reset (container restarted) — this run's total IS the delta
                DELTA_RX=$RX_BYTES
                DELTA_TX=$TX_BYTES
            else
                DELTA_RX=$((RX_BYTES - PREV_RX))
                DELTA_TX=$((TX_BYTES - PREV_TX))
            fi

            echo "Container=$CONTAINER | TotalSinceStart(RX/TX)=$RX_STR / $TX_STR | SinceLastCheck(RX/TX)=$(bytes_to_mb "$DELTA_RX")MB / $(bytes_to_mb "$DELTA_TX")MB" >> "$LOG_FILE"

            printf '%s\t%s\t%s\n' "$CONTAINER" "$RX_BYTES" "$TX_BYTES" >> "$NEW_CONTAINER_STATE"

        done

        mv "$NEW_CONTAINER_STATE" "$CONTAINER_STATE_FILE"

    else

        echo "No running Aksha containers." >> "$LOG_FILE"

    fi

fi


# ============================================================
# 6. HOST NETWORK INTERFACES
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- HOST NETWORK ----------" >> "$LOG_FILE"

cat /proc/net/dev >> "$LOG_FILE"


# ============================================================
# 6.5 HOST NETWORK USAGE (delta since last check)
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- HOST NETWORK USAGE (delta since last check) ----------" >> "$LOG_FILE"

IFACE=$(ip route | awk '/default/ {print $5; exit}')

if [ -n "$IFACE" ]; then

    READ_LINE=$(awk -v ifc="$IFACE" '{gsub(":", " "); if ($1==ifc) print $2, $10}' /proc/net/dev)
    CURR_RX=$(echo "$READ_LINE" | awk '{print $1}')
    CURR_TX=$(echo "$READ_LINE" | awk '{print $2}')

    if [ -z "$CURR_RX" ] || [ -z "$CURR_TX" ]; then

        echo "Interface : $IFACE (unable to read counters)" >> "$LOG_FILE"

    else

        PREV_LINE=$(cat "$HOST_STATE_FILE" 2>/dev/null)
        PREV_RX=$(echo "$PREV_LINE" | awk '{print $1}')
        PREV_TX=$(echo "$PREV_LINE" | awk '{print $2}')
        PREV_RX=${PREV_RX:-0}
        PREV_TX=${PREV_TX:-0}

        if [ "$CURR_RX" -lt "$PREV_RX" ] || [ "$CURR_TX" -lt "$PREV_TX" ]; then
            # Counters reset (reboot / interface reset)
            DELTA_RX=$CURR_RX
            DELTA_TX=$CURR_TX
        else
            DELTA_RX=$((CURR_RX - PREV_RX))
            DELTA_TX=$((CURR_TX - PREV_TX))
        fi

        echo "Interface        : $IFACE" >> "$LOG_FILE"
        echo "Since last check : RX=$(bytes_to_mb "$DELTA_RX")MB  TX=$(bytes_to_mb "$DELTA_TX")MB" >> "$LOG_FILE"

        echo "$CURR_RX $CURR_TX" > "$HOST_STATE_FILE"

    fi

else

    echo "Interface : NOT FOUND" >> "$LOG_FILE"

fi


# ============================================================
# 7. NETWORK INTERFACE SUMMARY
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- NETWORK INTERFACES ----------" >> "$LOG_FILE"

ip -br addr >> "$LOG_FILE"


# ============================================================
# 8. CPU
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- CPU ----------" >> "$LOG_FILE"

uptime >> "$LOG_FILE"


# ============================================================
# 9. MEMORY
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- MEMORY ----------" >> "$LOG_FILE"

free -h >> "$LOG_FILE"


# ============================================================
# 10. DISK
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- DISK ----------" >> "$LOG_FILE"

df -h / >> "$LOG_FILE"


# ============================================================
# 11. SYSTEM UPTIME
# ============================================================

echo "" >> "$LOG_FILE"
echo "---------- SYSTEM UPTIME ----------" >> "$LOG_FILE"

uptime -p >> "$LOG_FILE"


# ============================================================
# 12. END
# ============================================================

echo "" >> "$LOG_FILE"
echo "============================================================" >> "$LOG_FILE"
echo "CHECK COMPLETED: $TIMESTAMP" >> "$LOG_FILE"
echo "============================================================" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Also print result when manually executed
echo "Aksha monitoring completed."
echo "Log: $LOG_FILE"
