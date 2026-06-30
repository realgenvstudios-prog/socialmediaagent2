#!/usr/bin/env bash
# Reprocess all 8 videos sequentially with the current process_video.py.
# Transcripts are cached in Supabase so the audio download step is skipped.
# Each video: Claude clip selection → full video download → cut + burn all clips.

set -e
cd "$(dirname "$0")/.."
source venv/bin/activate

BASE_URL="https://www.youtube.com/watch?v="

run_video() {
  local vid="$1"
  local title="$2"
  echo ""
  echo "══════════════════════════════════════════════════════"
  echo "  Processing: $title"
  echo "  video_id:   $vid"
  echo "══════════════════════════════════════════════════════"
  python3 scripts/process_video.py \
    --video_id "$vid" \
    --url "${BASE_URL}${vid}" \
    --title "$title"
  echo "  ✓ Done: $vid"
}

run_video "D3qOFavKLp4" "The Man Who Owns 6 Businesses Reveals The One Skill That Made Him Millions"
run_video "ktpYxAy90hc" "27 Years In Corporate, \$2M Invested - Why This Ghanaian Left It All For Farming"
run_video "k9QP-JuaeTk" "Africa's #1 Event Planner: Marry The Wrong Person and Your Business Will Suffer"
run_video "Roeudl-7rDA" "The REAL Reason African Businesses Don't Scale"
run_video "wV0dd8DHbrA" "I Turned Down 3 Million Dollars"
run_video "DXAVFMbWjZs" "I Spent 20 Years Building Ghana's Most Influential Blog - And I Still Don't Have A Retirement Plan"
run_video "FQTMt7RqY-M" "He Built Nigeria's Biggest Creator Business from \$0 to Multimillion Dollars"
run_video -- "-zZ84zGslyQ" "How To Make Money In Real Estate With NOTHING"

echo ""
echo "All 8 videos reprocessed."
