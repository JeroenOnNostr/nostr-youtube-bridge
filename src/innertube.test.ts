import { describe, it, expect } from 'vitest';

import { extractChannelResults } from './innertube';

// Trimmed, realistic shape of a /youtubei/v1/search channel-filtered response.
const SEARCH_JSON = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    channelRenderer: {
                      channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
                      title: { simpleText: 'Veritasium' },
                      thumbnail: {
                        thumbnails: [
                          { url: '//yt3.ggpht.com/small.jpg', width: 88, height: 88 },
                          { url: '//yt3.ggpht.com/large.jpg', width: 800, height: 800 },
                        ],
                      },
                    },
                  },
                  {
                    // Non-channel item is ignored.
                    videoRenderer: { videoId: 'xxx' },
                  },
                  {
                    channelRenderer: {
                      channelId: 'UCabcdefghijklmnopqrstuv',
                      title: { runs: [{ text: 'Vsauce' }] },
                    },
                  },
                  {
                    // Duplicate channelId is deduped.
                    channelRenderer: {
                      channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
                      title: { simpleText: 'Veritasium (dup)' },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

describe('extractChannelResults', () => {
  it('parses channelRenderer items, picks the largest https thumbnail, dedupes', () => {
    const results = extractChannelResults(SEARCH_JSON);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      channelId: 'UCHnyfMqiRRG1u-2MsSQLbXA',
      title: 'Veritasium',
      thumbnail: 'https://yt3.ggpht.com/large.jpg',
    });
    expect(results[1]).toEqual({
      channelId: 'UCabcdefghijklmnopqrstuv',
      title: 'Vsauce',
      thumbnail: undefined,
    });
  });

  it('returns [] on an unexpected / bot-wall shape', () => {
    expect(extractChannelResults({})).toEqual([]);
    expect(extractChannelResults({ contents: {} })).toEqual([]);
    expect(extractChannelResults(null)).toEqual([]);
  });
});
