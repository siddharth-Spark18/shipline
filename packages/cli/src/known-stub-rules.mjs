// SHA-256 hashes of every rules/*.md file Shipline shipped up to 0.9.0 (the empty stubs, plus the jira.md and pr.md
// text that shipped with them). `upgrade` replaces a team's rules file with the new default only when its current
// content hashes to one of these, so a file the team edited is never touched. Hashes are of the LF-normalised text.
// Recorded from `git log -p -- packages/cli/templates/shipline/rules` (commits 1dba7ec, 8ada5b4, fbab938, 2e703bb).
export const KNOWN_STUB_RULES = {
  'feasibility.md': ['9f5839090d2beafb1b53922e65471eee1c3dc2f7b1e9e8e8d6e9aeace322d474'],
  'fix.md': ['2570f338876ce8ce35b0842849a665ef1e3496e4332d3436676771a95a526b4c'],
  'implement.md': ['3a1a026439b9ba3d317b32a6f68635f4689022d1cce6da7749f0d44e422ee950'],
  'jira.md': [
    '02719c4fcb9b7b6a37cb08d43ee7f697914da0dc257f73336393f4342eaf9ce7', // 0.6 - 0.8
    '5ee0a25ed110e94c842aed95b33ae5acc274c474f3cf23969822a0175e4236b8', // 0.9.0
  ],
  'plan.md': ['956fa795bad2301cc7338ba4d570af2c4d633891913da9ee15d0c353487d5e27'],
  'pr.md': [
    '4b60b9716e3ef33e1711554424a1a141f0521b2236d26f84563471f1fca26d9a',
    'd0841e1a29a449eccda969e423de39385445a2e22af94e4db564d72235d960d8',
    '834199f6c39ed182a5e94ab7935a2a879b887f3f28b20c2df1a264ae4ba1be2b', // 0.9.0
  ],
  'questions.md': ['6a9b28365e14af5425e8855897bb31c28f3ecde2614d3ad80289e1a78a27893a'],
  'reproduce.md': ['4e5a378690bd707f9e8c1033049e2e090b0ecdb7378b20acd1c9d6b2a7895f2e'],
  'root_cause.md': ['c06da69a926875b59a6ffe33119f46bbea91e4601a7ee38b28640850cbea589e'],
  'verify.md': ['dc3da553afae19ef11bec176e5ee0dfab10fd90e0ff88f6932b14b28bbc8dea1'],
  'wireframes.md': ['2499b67b491765f52ba1d2093224b870d0f09691f6f32249d52cddc78835e999'],
};
