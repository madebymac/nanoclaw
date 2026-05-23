// Poll GitHub for open PRs that need a bot review.
// Returns { wakeAgent: bool, data: { prs: [...] } }
//
// Configure:
//   repos    - list of "owner/repo" strings to watch
//   botLogin - your GitHub App's bot identity (e.g. "my-review-bot[bot]")
//              Must match the bot login in agent-prompt.md.

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
      // Reviewed before — re-include only if new commits pushed since last review
      const lastBotReview = botReviews[botReviews.length - 1];
      if (lastBotReview.commit_id !== pr.head.sha) {
        results.push({ repo, number: pr.number, title: pr.title, url: pr.html_url });
      }
    }
  }
}

console.log(JSON.stringify({ wakeAgent: results.length > 0, data: { prs: results } }));
