#!/usr/bin/env bash
set -euo pipefail

# Ensure dependencies are available
command -v ffmpeg >/dev/null 2>&1 || { echo "Error: ffmpeg is not installed." >&2; exit 1; }

usage() {
  echo "Usage: $0 <youtube_url_or_file_path> <level_name>"
  exit 1
}

if [[ $# -lt 2 ]]; then
  usage
fi

INPUT="$1"
LEVEL_NAME="$2"
OUTPUT_DIR="./public/levels/${LEVEL_NAME}"

mkdir -p "${OUTPUT_DIR}"

# Create a temporary directory for intermediate downloads
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "${TEMP_DIR}"' EXIT

SOURCE_FILE=""

# Check if the input is a local file or a remote URL
if [[ -f "${INPUT}" ]]; then
  SOURCE_FILE="${INPUT}"
else
  command -v yt-dlp >/dev/null 2>&1 || { echo "Error: yt-dlp is not installed." >&2; exit 1; }
  
  echo "Downloading video via yt-dlp..."
  SOURCE_FILE="${TEMP_DIR}/downloaded.mkv"
  yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mkv -o "${SOURCE_FILE}" "${INPUT}"
fi

echo "Processing assets for '${LEVEL_NAME}'..."

# 1. Extract audio to Opus (160k VBR is transparent quality, sample-accurate)
ffmpeg -y -v error -i "${SOURCE_FILE}" \
  -vn \
  -c:a libopus -b:a 160k -vbr on \
  "${OUTPUT_DIR}/audio.opus"

# 2. Extract muted H.264 MP4 for universal web browser playback
#    (H.264 is hardware-decoded on macOS, Windows, iOS and Android — VP9 is not)
ffmpeg -y -v error -i "${SOURCE_FILE}" \
  -an \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -profile:v high -level 4.0 -movflags +faststart \
  "${OUTPUT_DIR}/video.mp4"

echo "Complete! Assets generated in ${OUTPUT_DIR}:"
ls -lh "${OUTPUT_DIR}"