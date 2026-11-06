// SHA-256 hashes of the rules/*.md files Shipline ships (LF-normalised text). `upgrade` replaces a team's rules file with
// the new default only when its current content hashes to one of these, so a file the team edited is never touched.
// 1.0.0 is the first release, so each file lists only its 1.0.0 text. When a rules template changes, ADD the hash of
// its previous text here (keep the old ones) so an untouched older copy is still recognised.
export const KNOWN_STUB_RULES = {
  'feasibility.md': ['b09cf5ff21c1e4ecb18d714bba201dbaefc044ec06840dcefc39cb920590a228'],
  'fix.md': ['f36f1df1b2cfb4472030f7ad075d1a511a732b153547ef994476aac1bda80420'],
  'implement.md': ['6b8956a0f74dcda08691377a36249d0af29191748ca3c3549f2fcdc14a188c10'],
  'plan.md': ['01328226d3d510d9381af4c5e4fa31f43b7eb8e8bf93de081eae712565cd7d39'],
  'pr.md': ['8cf2f58b8e7ef3cd676b84a1c284829369e445e049e36c03115d7857b9a0f941'],
  'questions.md': ['74b19f1cd33cb87f471600fb63b50d83fe4914005e822da8acaa1881259cf8c5'],
  'reproduce.md': ['a68bd9093a93f840c275a2d4c2989e716eb39fcd01adf2dbe4f3d61c50894cde'],
  'root_cause.md': ['42312491d08529695ff32581a8789160a74b8ea53a55a8593a392159b42f02c2'],
  'ticket.md': ['72935e087979e1badfa712f2853507f5968e845b9347db3ec8c88a7477f9534a'],
  'verify.md': ['37d392f563cdb5c5598edd1cb94cf500b814635f793b14f3fc0703375ff18c6b'],
  'wireframes.md': ['fda457e6e00f143a02c627bdcfc3c0fe26055a543eec89df6d44d2248b752b77'],
};
