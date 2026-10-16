-- Audio is additive: existing image/video assets and rows remain unchanged.
ALTER TYPE "ContentMediaKind" ADD VALUE IF NOT EXISTS 'AUDIO';
