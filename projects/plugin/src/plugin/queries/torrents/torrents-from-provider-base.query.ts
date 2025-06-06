import { replacer, WakoHttpError } from '@wako-app/mobile-sdk';
import { concat, forkJoin, Observable, of, throwError } from 'rxjs';
import { catchError, last, map, mapTo, switchMap, tap } from 'rxjs/operators';
import { Provider, ProviderQueryInfo, ProviderQueryReplacement, ProviderResponse } from '../../entities/provider';
import { SourceQuality } from '../../entities/source-quality';
import { SourceQuery } from '../../entities/source-query';
import { TorrentSource } from '../../entities/torrent-source';
import { ProviderHttpService } from '../../services/provider-http.service';
import { SourceUtils } from '../../services/source-utils';
import { cleanTitleCustom, getHashFromUrl, logData } from '../../services/tools';
import { TorrentGetUrlQuery } from './torrent-get-url.query';

function bodyReplacer(tpl: string, data: { [key: string]: any }) {
  return tpl.replace(/{([a-z0-9\.]*)}/g, ($1, $2) => {
    if (!$1.match('{') || !$1.match('}')) {
      return $1;
    }
    return data[$2];
  });
}

interface ProviderToken {
  token: string;
  generatedDate: Date;
}

interface ProviderTorrentResult {
  providerName: string;
  title: string;
  seeds: number;
  peers: number;
  size: number;
  quality: SourceQuality;
  url: string;
  subPageUrl: string;
  isPackage: boolean;
  hash: string;
}

export abstract class TorrentsFromProviderBaseQuery {
  private static tokenByProvider = new Map<string, ProviderToken>();

  protected static getTorrents(
    provider: Provider,
    sourceQuery: SourceQuery,
    providerInfo: ProviderQueryInfo,
  ): Observable<ProviderResponse[]> {
    return this.getToken(provider).pipe(
      switchMap((token) => {
        return this._getTorrents(token, provider, sourceQuery, providerInfo).pipe(
          catchError((err) => {
            if (err instanceof WakoHttpError && err.status > 0) {
              // Something goes wrong
              return throwError(err);
            }

            // maybe block
            if (provider.fallback_urls) {
              const newUrl = provider.fallback_urls.shift();
              if (newUrl) {
                logData('use fallback url', newUrl, 'for', provider.name);
                provider.base_url = newUrl;
                return this.getTorrents(provider, sourceQuery, providerInfo);
              }
            }
            return throwError(err);
          }),
        );
      }),
    );
  }

  private static getToken(provider: Provider) {
    if (!provider.token) {
      return of('');
    }

    logData(`Retrieving token for ${provider.name}`);

    return ProviderHttpService.request(
      {
        method: 'GET',
        url: provider.base_url + provider.token.query,
        responseType: provider.response_type,
      },
      provider.token.token_validity_time_ms || null,
      provider.timeout_ms || 15000,
      true,
      provider.time_to_wait_on_too_many_request_ms,
      provider.time_to_wait_between_each_request_ms,
    ).pipe(
      map((response) => {
        const _token = response[provider.token.token_format.token];

        this.tokenByProvider.set(provider.name, {
          token: _token,
          generatedDate: new Date(),
        });

        logData(`Token ${_token} has been retrieved for ${provider.name}`);

        return _token;
      }),
    );
  }

  private static _getTorrents(
    token: string,
    provider: Provider,
    sourceQuery: SourceQuery,
    providerInfo: ProviderQueryInfo,
  ): Observable<ProviderResponse[]> {
    const keywords = typeof providerInfo.keywords === 'string' ? [providerInfo.keywords] : providerInfo.keywords;

    const torrentsObs = [];

    const providerUrls = [];

    const providerResponses: ProviderResponse[] = [];

    keywords.forEach((keyword) => {
      const isPost = provider.http_method === 'POST';

      const data = this.getProviderQueryReplacement(provider, sourceQuery, keyword, token, isPost);

      let query = replacer(keyword, data.cleanedReplacement).trim();
      const originalQuery = replacer(keyword, data.rawReplacement).trim();

      if (provider.separator) {
        query = query.replace(/\s/g, provider.separator);
      } else if (!isPost) {
        query = encodeURIComponent(query);
      }

      const replacerObj = Object.assign({ query: query }, data ? data.cleanedReplacement : {});

      if (provider.base_url.match('imdbId') !== null || keyword.match('imdbId') !== null) {
        if (data && data.rawReplacement.imdbId === '') {
          const providerResponse = new ProviderResponse({
            url: provider.base_url + providerInfo.query,
            method: provider.http_method === 'POST' ? 'POST' : 'GET',
            status: 0,
            torrents: [],
            timeElapsed: 0,
            skippedReason: `Keyword: "${keyword}" not provided in the query - Skip`,
          });

          providerResponses.push(providerResponse);

          return;
        }
      }

      let providerBody = null;

      let providerUrl = provider.base_url;
      if (provider.http_method === 'POST') {
        providerBody = bodyReplacer(providerInfo.query, replacerObj);
        try {
          providerBody = JSON.parse(providerBody);
        } catch (e) {}
      } else {
        providerUrl = replacer(provider.base_url + providerInfo.query, replacerObj);
      }

      if (providerUrls.includes(providerUrl)) {
        return;
      }

      providerUrls.push(providerUrl);

      const providerResponse = new ProviderResponse({
        url: providerUrl,
        method: provider.http_method === 'POST' ? 'POST' : 'GET',
        body: providerBody,
        status: 0,
        torrents: [],
        timeElapsed: 0,
      });

      providerResponses.push(providerResponse);

      const start = Date.now();
      torrentsObs.push(
        this.doProviderHttpRequest(providerUrl, provider, providerBody).pipe(
          catchError((err) => {
            let errorMessage = '';
            if (typeof err === 'string') {
              errorMessage = err;
            } else if (err instanceof WakoHttpError && err.status) {
              errorMessage = err.status.toString();
            } else if (err.message) {
              errorMessage = err.message;
            } else {
              errorMessage = JSON.stringify(err);
            }

            if (err instanceof WakoHttpError && err.status > 0) {
              providerResponse.status = err.status;

              if (err.status && err.status === 404) {
                return of([]);
              }
              console.error(`Error ${err.status} on ${provider.name} (${providerUrl}}`, err);
              return of([]);
            }

            providerResponse.error = errorMessage;
            providerResponse.status = 500;

            return of([]);
          }),
          map((response) => {
            if (!response) {
              return [];
            }
            return this.getTorrentsFromProviderHttpResponse(response, provider, providerUrl);
          }),
          map((_torrents) => {
            return this.setVideoMetadata(_torrents, sourceQuery);
          }),
          map((_torrents) => {
            return this.removeUnwantedTorrents(_torrents);
          }),
          map((_torrents) => {
            if (sourceQuery.movie && provider.trust_movie_results) {
              return _torrents;
            } else if (sourceQuery.episode && provider.trust_episode_results && sourceQuery.category === 'tv') {
              return _torrents;
            } else if (sourceQuery.episode && provider.trust_anime_results && sourceQuery.category === 'anime') {
              return _torrents;
            }
            return this.removeBadTorrents(_torrents, originalQuery, sourceQuery);
          }),
          switchMap((_torrents) => {
            return this.getHashFromSubPages(_torrents);
          }),
          tap((_torrents) => {
            providerResponse.torrents = providerResponse.torrents.concat(_torrents);
            providerResponse.timeElapsed = Date.now() - start;
            logData(`${provider.name} - Found ${providerResponse.torrents.length} torrents - URL: "${providerUrl}"`);
          }),
        ),
      );
    });

    const _obs = torrentsObs.length === 0 ? of([]) : concat(...torrentsObs);

    return _obs.pipe(
      last(),
      map(() => {
        return providerResponses;
      }),
    );
  }

  static getHashFromUrl(url: string) {
    if (url && url.match(/btih:([a-zA-Z0-9]*)/)) {
      const match = url.match(/btih:([a-zA-Z0-9]*)/);
      return match.length > 1 ? match[1].trim().toLowerCase() : null;
    } else if (url && url.match(/(\w{40})/)) {
      const match = url.match(/(\w{40})/);
      return match.length > 1 ? match[1].trim().toLowerCase() : null;
    }
    return getHashFromUrl(url);
  }

  private static setVideoMetadata(torrents: TorrentSource[], sourceQuery: SourceQuery) {
    torrents.forEach((torrent) => {
      torrent.videoMetaData = SourceUtils.getVideoMetadata(torrent.title, sourceQuery);
    });
    return torrents;
  }

  private static removeUnwantedTorrents(torrents: TorrentSource[]) {
    return torrents.filter((torrent) => {
      if (torrent.videoMetaData.isCam) {
        logData('Exclude from', torrent.provider, torrent.title, 'cause hdcam');
        return false;
      }

      if (torrent.videoMetaData.is3D) {
        logData('Exclude from', torrent.provider, torrent.title, 'cause 3D');
        return false;
      }

      return true;
    });
  }

  private static removeBadTorrents(torrents: TorrentSource[], originalQuery: string, sourceQuery: SourceQuery) {
    return torrents.filter((torrent) => {
      if (sourceQuery.query) {
        if (!SourceUtils.isWordMatching(torrent.title, originalQuery, 0)) {
          logData('Exclude Query from', torrent.provider, torrent.title, 'cause no matching');
          return false;
        }
        return true;
      }

      if (sourceQuery.movie) {
        if (!SourceUtils.isMovieTitleMatching(torrent.title, originalQuery, sourceQuery.movie)) {
          logData('Exclude Movie from', torrent.provider, torrent.title, 'cause no matching');
          return false;
        }
        return true;
      }

      if (sourceQuery.episode) {
        if (SourceUtils.isEpisodeTitleMatching(torrent.title, originalQuery, sourceQuery.episode)) {
          return true;
        } else {
          logData('Exclude Episode from', torrent.provider, torrent.title, 'cause no matching');
        }

        if (SourceUtils.isSeasonPackTitleMatching(torrent.title, originalQuery, sourceQuery.episode)) {
          torrent.isPackage = true;
          return true;
        } else {
          logData('Exclude SeasonPack from', torrent.provider, torrent.title, 'cause no matching');
        }

        return false;
      }

      return true;
    });
  }

  private static getProviderQueryReplacement(
    provider: Provider,
    sourceQuery: SourceQuery,
    keywords: string,
    token?: string,
    isPost = false,
  ): { rawReplacement: ProviderQueryReplacement; cleanedReplacement: ProviderQueryReplacement } {
    if (!provider.title_replacement) {
      // Backward compatibility
      provider.title_replacement = {
        "'s": 's',
        '"': ' ',
      };
    }

    let rawReplacement: ProviderQueryReplacement = null;
    let cleanedReplacement: ProviderQueryReplacement = null;

    if (sourceQuery.query) {
      rawReplacement = {
        title: sourceQuery.query,
        titleFirstLetter: sourceQuery.query[0],
        token: token,
        year: '',
        imdbId: '',
        episodeCode: '',
        seasonCode: '',
        season: '',
        episode: '',
        absoluteNumber: '',

        query: sourceQuery.query,
      };

      cleanedReplacement = Object.assign({}, rawReplacement);
    } else {
      const query = sourceQuery.movie ? sourceQuery.movie : sourceQuery.episode;

      rawReplacement = {
        title: query.title,
        titleFirstLetter: query.title[0],
        token: token,
        year: typeof query.year === 'number' ? query.year.toString() : '',
        imdbId: query.imdbId ? query.imdbId : '',
        episodeCode: sourceQuery.episode ? sourceQuery.episode.episodeCode.toLowerCase() : '',
        seasonCode: sourceQuery.episode ? sourceQuery.episode.seasonCode.toLowerCase() : '',
        season: sourceQuery.episode ? sourceQuery.episode.seasonNumber.toString() : '',
        episode: sourceQuery.episode ? sourceQuery.episode.episodeNumber.toString() : '',
        absoluteNumber:
          sourceQuery.episode && sourceQuery.episode.absoluteNumber
            ? sourceQuery.episode.absoluteNumber.toString()
            : '',

        query: '',
      };

      if (sourceQuery.episode) {
        rawReplacement.tvdbId = sourceQuery.episode.tvdbId;
        rawReplacement.trakId = sourceQuery.episode.trakId ? sourceQuery.episode.trakId.toString() : '';
        rawReplacement.simklId = sourceQuery.episode.simklId ? sourceQuery.episode.simklId.toString() : '';

        rawReplacement.showTvdbId = sourceQuery.episode.showTvdbId;
        rawReplacement.showTraktId = sourceQuery.episode.showTraktId ? sourceQuery.episode.showTraktId.toString() : '';
        rawReplacement.showTmdbId = sourceQuery.episode.showTmdbId ? sourceQuery.episode.showTmdbId.toString() : '';
        rawReplacement.showSimklId = sourceQuery.episode.showSimklId ? sourceQuery.episode.showSimklId.toString() : '';
        rawReplacement.showImdbId = sourceQuery.episode.showImdbId ? sourceQuery.episode.showImdbId.toString() : '';
      }

      cleanedReplacement = Object.assign({}, rawReplacement);

      if (query.alternativeTitles) {
        Object.keys(query.alternativeTitles).forEach((language) => {
          rawReplacement['title.' + language] = query.alternativeTitles[language];
          cleanedReplacement['title.' + language] = SourceUtils.cleanTitle(
            cleanTitleCustom(query.alternativeTitles[language], provider.title_replacement),
          );
        });
      }
      if (query.originalTitle) {
        rawReplacement['title.original'] = query.originalTitle;
        cleanedReplacement['title.original'] = SourceUtils.cleanTitle(
          cleanTitleCustom(query.originalTitle, provider.title_replacement),
        );
      }
    }

    cleanedReplacement.title = SourceUtils.cleanTitle(
      cleanTitleCustom(rawReplacement.title, provider.title_replacement),
    );
    cleanedReplacement.titleFirstLetter = cleanedReplacement.title[0];

    rawReplacement.query = replacer(keywords, rawReplacement).trim();
    cleanedReplacement.query = replacer(keywords, cleanedReplacement).trim();

    if (provider.separator) {
      rawReplacement.query = rawReplacement.query.replace(/\s/g, provider.separator);
      cleanedReplacement.query = cleanedReplacement.query.replace(/\s/g, provider.separator);
    } else if (!isPost) {
      rawReplacement.query = encodeURIComponent(rawReplacement.query);
      cleanedReplacement.query = encodeURIComponent(cleanedReplacement.query);
    }

    return { rawReplacement, cleanedReplacement };
  }

  private static doProviderHttpRequest(providerUrl: string, provider: Provider, providerBody = null) {
    logData(`Getting "${providerUrl}" from ${provider.name} provider`);

    const headers = {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36',
    };
    if (provider.response_type === 'text') {
      headers['accept'] = 'text/html';
    }

    if (providerBody) {
      headers['Content-Type'] = 'application/json';
    }

    return ProviderHttpService.request<any>(
      {
        method: provider.http_method || 'GET',
        headers: headers,
        url: providerUrl,
        responseType: provider.response_type === 'json' ? 'json' : 'text',
        body: providerBody,
      },
      null,
      provider.timeout_ms || 15000,
      true,
      provider.time_to_wait_on_too_many_request_ms,
      provider.time_to_wait_between_each_request_ms,
    );
  }

  private static getObjectFromKey(rootObject: object, keyString: string): any {
    try {
      let results = rootObject;
      keyString.split('.').forEach((key) => {
        if (results && results.hasOwnProperty(key)) {
          results = results[key];
        } else {
          results = null;
        }
      });

      return results;
    } catch (e) {
      return null;
    }
  }

  private static getSize(size: number | string) {
    if (size === null) {
      return null;
    }

    if (Number(size)) {
      return +size;
    } else {
      const sizeBytes = SourceUtils.convertSizeStrToBytes(size as string);
      if (sizeBytes !== null) {
        return sizeBytes;
      } else {
        console.error(`Cannot convert ${size} to bytes`);
      }
    }

    return 0;
  }

  private static getFormatIntIfNotNull(value: number | string) {
    if (value === null) {
      return null;
    }
    return +value;
  }

  private static addBaseUrlIfNeeded(baseUrl: string, torrentUrl: string) {
    if (torrentUrl[0] === '/') {
      return baseUrl + torrentUrl;
    }
    return torrentUrl;
  }

  private static getTorrentsFromJsonResponse(provider: Provider, response: any): ProviderTorrentResult[] {
    const torrents: ProviderTorrentResult[] = [];

    try {
      const results = provider.json_format.results
        ? this.getObjectFromKey(response, provider.json_format.results)
        : response;

      if (!results) {
        return torrents;
      }

      results.forEach((result: any) => {
        const title = result[provider.json_format.title];

        if (provider.json_format.sub_results) {
          const subResults = this.getObjectFromKey(result, provider.json_format.sub_results);

          try {
            subResults.forEach((subResult) => {
              try {
                const quality = provider.json_format.quality
                  ? this.getObjectFromKey(subResult, provider.json_format.quality)
                  : SourceUtils.getQuality(title);

                let torrentUrl = provider.json_format.url
                  ? this.addBaseUrlIfNeeded(
                      provider.base_url,
                      this.getObjectFromKey(subResult, provider.json_format.url),
                    )
                  : null;
                let subPageUrl = null;

                if (provider.source_is_in_sub_page) {
                  subPageUrl = torrentUrl;
                  torrentUrl = null;
                }

                const torrent: ProviderTorrentResult = {
                  providerName: provider.name,
                  title: title,
                  url: torrentUrl,
                  subPageUrl: subPageUrl,
                  seeds: this.getFormatIntIfNotNull(this.getObjectFromKey(subResult, provider.json_format.seeds)),
                  peers: this.getFormatIntIfNotNull(this.getObjectFromKey(subResult, provider.json_format.peers)),
                  quality: SourceUtils.getQuality(quality),
                  size: 0,
                  isPackage: !!(
                    provider.json_format.isPackage !== undefined &&
                    this.getObjectFromKey(result, provider.json_format.isPackage)
                  ),
                  hash:
                    provider.json_format.hash !== undefined && this.getObjectFromKey(result, provider.json_format.hash),
                };

                if (!torrent.url && !torrent.subPageUrl) {
                  return;
                }

                const size = this.getObjectFromKey(subResult, provider.json_format.size);

                torrent.size = this.getSize(size);

                torrents.push(torrent);
              } catch (e) {}
            });
          } catch (e) {}
        } else {
          const quality = provider.json_format.quality
            ? this.getObjectFromKey(result, provider.json_format.quality)
            : SourceUtils.getQuality(title);

          let torrentUrl = provider.json_format.url
            ? this.addBaseUrlIfNeeded(provider.base_url, this.getObjectFromKey(result, provider.json_format.url))
            : null;
          let subPageUrl = null;

          if (provider.source_is_in_sub_page) {
            subPageUrl = torrentUrl;
            torrentUrl = null;
          }
          const torrent: ProviderTorrentResult = {
            providerName: provider.name,
            title: title,
            url: torrentUrl,
            subPageUrl: subPageUrl,
            seeds: this.getFormatIntIfNotNull(this.getObjectFromKey(result, provider.json_format.seeds)),
            peers: this.getFormatIntIfNotNull(this.getObjectFromKey(result, provider.json_format.peers)),
            size: this.getObjectFromKey(result, provider.json_format.size),
            quality: SourceUtils.getQuality(quality),
            isPackage: !!(
              provider.json_format.isPackage !== undefined &&
              this.getObjectFromKey(result, provider.json_format.isPackage)
            ),
            hash: provider.json_format.hash !== undefined && this.getObjectFromKey(result, provider.json_format.hash),
          };

          if (torrent.hash && !torrent.url && !torrent.subPageUrl) {
            torrent.url = `magnet:?xt=urn:btih:${torrent.hash}`;
          }

          if (!torrent.url && !torrent.subPageUrl && !torrent.hash) {
            return;
          }

          const size = this.getObjectFromKey(result, provider.json_format.size);

          torrent.size = this.getSize(size);

          torrents.push(torrent);
        }
      });
    } catch (e) {
      console.error(`Error on provider ${provider.name}`, e, response);
    }

    return torrents;
  }

  private static getTorrentsFromTextResponse(
    provider: Provider,
    response: any,
    providerUrl: string,
  ): ProviderTorrentResult[] {
    const torrents: ProviderTorrentResult[] = [];

    const parser = new DOMParser();
    const doc = parser.parseFromString(response, 'text/html');

    const rows = this.evalCode(doc, providerUrl, provider, 'row') as NodeListOf<HTMLTableRowElement>;

    if (rows) {
      rows.forEach((row) => {
        try {
          const title = this.evalCode(row, providerUrl, provider, 'title');

          let torrentUrl = this.addBaseUrlIfNeeded(provider.base_url, this.evalCode(row, providerUrl, provider, 'url'));

          let subPageUrl = null;

          if (provider.source_is_in_sub_page) {
            subPageUrl = torrentUrl;
            torrentUrl = null;
          }

          const torrent: ProviderTorrentResult = {
            providerName: provider.name,
            title: title,
            url: torrentUrl,
            subPageUrl: subPageUrl,
            seeds: this.getFormatIntIfNotNull(this.evalCode(row, providerUrl, provider, 'seeds')),
            peers: this.getFormatIntIfNotNull(this.evalCode(row, providerUrl, provider, 'peers')),
            quality: SourceUtils.getQuality(title),
            size: 0,
            isPackage: this.evalCode(row, providerUrl, provider, 'isPackage') ? true : false,
            hash: this.evalCode(row, providerUrl, provider, 'hash'),
          };

          if (!torrent.url && !torrent.subPageUrl) {
            return;
          }

          const size = this.evalCode(row, providerUrl, provider, 'size');

          torrent.size = this.getSize(size);

          torrents.push(torrent);
        } catch (e) {
          // console.error(`Error on provider ${provider.name}`, e, response);
        }
      });
    }

    return torrents;
  }

  private static evalCode(element: HTMLElement | Document, url: string, provider: Provider, field: string) {
    const code = provider.html_parser[field];
    try {
      return Function('doc', 'row', 'code', `return eval(code)`)(element, element, provider.html_parser[field]);
    } catch (e) {
      // console.error(`Failed to execute ${field} code: ${code} for provider ${provider.name}. Url: ${url}`, e.toString());
      return null;
    }
  }

  private static transformProviderTorrentResultToTorrentSource(providerTorrentResult: ProviderTorrentResult) {
    let id = null;
    const hash = providerTorrentResult.hash ?? this.getHashFromUrl(providerTorrentResult.url);
    if (hash) {
      id = providerTorrentResult.providerName + '-' + hash;
    } else {
      id =
        providerTorrentResult.providerName + '-' + providerTorrentResult.url + '-' + providerTorrentResult.subPageUrl;
    }

    const torrent: TorrentSource = {
      id: id,
      provider: providerTorrentResult.providerName,
      title: providerTorrentResult.title,
      seeds: providerTorrentResult.seeds,
      peers: providerTorrentResult.peers,
      size: providerTorrentResult.size,
      quality: providerTorrentResult.quality,
      url: providerTorrentResult.url,
      subPageUrl: providerTorrentResult.subPageUrl,
      isPackage: providerTorrentResult.isPackage,
      hash: hash,
      isCached: false,
      type: 'torrent',
    };

    return torrent;
  }

  private static getTorrentsFromProviderHttpResponse(
    response: any,
    provider: Provider,
    providerUrl: string,
  ): TorrentSource[] {
    let providerTorrentResults: ProviderTorrentResult[] = [];

    if (provider.json_format) {
      providerTorrentResults = this.getTorrentsFromJsonResponse(provider, response);
    } else {
      providerTorrentResults = this.getTorrentsFromTextResponse(provider, response, providerUrl);
    }

    const torrentSources: TorrentSource[] = [];

    providerTorrentResults.forEach((providerTorrentResult) => {
      torrentSources.push(this.transformProviderTorrentResultToTorrentSource(providerTorrentResult));
    });

    return torrentSources;
  }

  private static getHashFromSubPages(torrents: TorrentSource[]) {
    if (torrents.length === 0) {
      return of(torrents);
    }
    const obss: Observable<TorrentSource>[] = [];

    const allTorrents: TorrentSource[] = [];
    const allHashes = [];

    torrents.forEach((torrent) => {
      if (torrent.hash || !torrent.subPageUrl) {
        if (torrent.hash) {
          allHashes.push(torrent.hash);
        }
        allTorrents.push(torrent);
        obss.push(of(torrent));
        return;
      }
      const obs = TorrentGetUrlQuery.getData(torrent.url, torrent.subPageUrl).pipe(
        map((url) => {
          if (url) {
            torrent.url = url;
            torrent.hash = TorrentsFromProviderBaseQuery.getHashFromUrl(url);
          }
          if (!torrent.hash) {
            allTorrents.push(torrent);
          } else if (!allHashes.includes(torrent.hash)) {
            allHashes.push(torrent.hash);
            allTorrents.push(torrent);
          }
          return torrent;
        }),
      );
      obss.push(obs);
    });
    return forkJoin(obss).pipe(mapTo(allTorrents));
  }
}
