/** Validate account structure before promoting a Solana address to a mint.
 * SPL Token Mint is 82 bytes. Token-2022 extended Mints pad to offset 165,
 * then carry AccountType=1 and a TLV extension stream from offset 166.
 */
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export function decodeMintAccount(
  owner: string | undefined, data: Uint8Array,
): { decimals: number; owner: string } | null {
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) return null;
  if (data.length !== 82) {
    if (owner !== TOKEN_2022_PROGRAM || data.length < 166 || data[165] !== 1) return null;
    // Extended Mints pad their 82-byte base layout to the account-type byte.
    for (let i = 82; i < 165; i++) if (data[i] !== 0) return null;
    // Token-2022 TLV header: extension type (u16), payload length (u16).
    // Reject malformed/truncated extension storage, not unknown extension IDs.
    for (let offset = 166; offset < data.length;) {
      if (offset + 4 > data.length) return null;
      const kind = data[offset] | (data[offset + 1] << 8);
      const size = data[offset + 2] | (data[offset + 3] << 8);
      if (kind === 0 && size === 0) {
        // Allocated but unused TLV capacity is zero-filled.
        for (let i = offset; i < data.length; i++) if (data[i] !== 0) return null;
        break;
      }
      offset += 4 + size;
      if (offset > data.length) return null;
    }
  }
  // COption<Pubkey> tags for mint and freeze authority; base SPL Mint layout.
  const bytes = Buffer.from(data);
  const mintAuthority = bytes.readUInt32LE(0);
  const freezeAuthority = bytes.readUInt32LE(46);
  if (mintAuthority > 1 || freezeAuthority > 1 || data[45] !== 1 || data[44] > 30) return null;
  return { decimals: data[44], owner };
}
