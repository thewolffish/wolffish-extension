#!/bin/bash
# Usage: ./update_version.sh <new_version>
# FORMAT IS <0.0.0>

if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  find . -name 'package.json' -not -path '*/node_modules/*' -exec bash -c '
    # Only replace the "version" field, not dependency versions
    perl -i -pe"s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"'$1'\"/" "$0"
  '  {} \;

  echo "Updated versions to $1";
else
  echo "Version format <$1> isn't correct, proper format is <0.0.0>";
fi
