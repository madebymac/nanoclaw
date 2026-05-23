// Poll GitHub for open PRs that need a bot review.
// Returns { wakeAgent: bool, data: { prs: [...] } }
//
// Configure:
//   repos    - list of "owner/repo" strings to watch
//   botLogin - your GitHub App's bot identity (e.g. "my-review-bot[bot]")
//              Must match the bot login in agent-prompt.md.
//
// Note: fetch calls below rely on NanoClaw's OneCLI gateway to inject GitHub credentials
// transparently. Without the gateway, GitHub's anonymous rate limit (60 req/hr) will
// exhaust quickly with a 1-minute poll interval.

const repos = [
  'owner/repo-1',
  'owner/repo-2',
];
const botLogin = 'my-review-bot[bot]';

const results = [];

for (const repo of repos) {
  let prs = [];
  try {
    let page = 1;
    while (true) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&page=${page}`
      );
      if (!res.ok) {
        process.stderr.write(`Failed to fetch PRs for ${repo}: ${res.status}\n`);
        break;
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      prs.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
  } catch (err) {
    process.stderr.write(`Error fetching PRs for ${repo}: ${err.message}\n`);
    continue;
  }

  for (const pr of prs) {
    // Skip drafts (author isn't asking for feedback yet) and bot-authored PRs
    // (GitHub rejects REQUEST_CHANGES on a PR authored by the same app identity)
    if (pr.draft) continue;
    if (pr.user && pr.user.login === botLogin) continue;

    let reviews;
    try {
      // Fetch all reviews — paginate to handle PRs with many reviews
      reviews = [];
      let page = 1;
      while (true) {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/pulls/${pr.number}/reviews?per_page=100&page=${page}`
        );
        if (!res.ok) break;
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        reviews.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
    } catch (err) {
      process.stderr.write(`Error fetching reviews for ${repo}#${pr.number}: ${err.message}\n`);
      continue;
    }

    const botReviews = reviews.filter(r => r.user && r.user.login === botLogin);

    if (botReviews.length === 0) {
      // Never reviewed — include
      results.push({ repo, number: pr.number, title: pr.title, url: pr.html_url });
    } else {
      // Re-include only if no bot review matches the current head commit.
      // Uses .some() rather than picking the last array entry to avoid relying
      // on GitHub's undocumented sort order.
      if (!botReviews.some(r => r.commit_id === pr.head.sha)) {
        results.push({ repo, number: pr.number, title: pr.title, url: pr.html_url });
      }
    }
  }
}

console.log(JSON.stringify({ wakeAgent: results.length > 0, data: { prs: results } }));
