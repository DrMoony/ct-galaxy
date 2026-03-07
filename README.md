# CT-Galaxy: Clinical Trial Search & Analysis

Interactive clinical trial search tool powered by ClinicalTrials.gov API v2 with AI-assisted comparison.

## Features

- **Search**: Full-text search with phase, status, and date filters
- **Galaxy Map**: Canvas 2D visualization of drug molecules sized by enrollment, grouped by mechanism of action
- **Trial Comparison**: Side-by-side comparison of 2–4 trials with criteria diff, timeline, and site analysis
- **AI Analysis**: Concept-based criteria grouping via Gemini (free), Claude, or OpenAI
- **Drug Intelligence**: Automatic brand→generic resolution, dose stripping, BAT drug exclusion

## Live Demo

Visit: `https://<your-username>.github.io/ct-galaxy/`

## Quick Start

Just open `index.html` in any modern browser. No server or build step required.

All API calls are client-side:
- ClinicalTrials.gov API (public, no auth needed)
- AI APIs (bring your own key — entered in browser, stored in localStorage)

## Tech Stack

- Pure HTML/CSS/JavaScript (single file, ~260KB)
- Canvas 2D for Galaxy Map visualization
- ClinicalTrials.gov API v2
- Multi-provider LLM integration (Gemini / Claude / OpenAI)

## License

For research and educational use.
