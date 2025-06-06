import { Injectable } from '@angular/core';
import {
  EventCategory,
  EventName,
  EventService,
  isSameId,
  OpenMedia,
  Playlist,
  PlaylistService,
  PlaylistVideo,
  WakoStorage,
} from '@wako-app/mobile-sdk';
import { KodiOpenMedia } from '../entities/kodi-open-media';
import { StreamLinkSource } from '../entities/stream-link-source';
import { TorrentSource } from '../entities/torrent-source';

@Injectable()
export class HeliosPlaylistService {
  private playListService: PlaylistService;

  constructor(private storage: WakoStorage) {
    PlaylistService.initialize(this.storage);

    this.playListService = PlaylistService.getInstance();
  }

  async getAll() {
    return await this.playListService.getAllPlaylistsSortedByDateDesc();
  }

  async getPlaylistFromVideoUrl(videoUrl: string) {
    const playlists = await this.getAll();
    for (const playlist of playlists) {
      for (const item of playlist.items) {
        if (item.url === videoUrl) {
          return playlist;
        }
      }
    }
    return null;
  }

  getPlaylist(sourceId: string, label: string, kodiOpenMedia?: KodiOpenMedia) {
    let id = sourceId;
    let poster = null;

    if (kodiOpenMedia) {
      const openMedia: OpenMedia = {
        episodeNumber: kodiOpenMedia?.episode?.number,
        seasonNumber: kodiOpenMedia?.episode?.seasonNumber,
        movieIds: kodiOpenMedia?.movie?.ids,
        showIds: kodiOpenMedia?.show?.ids,
      };
      id = this.playListService.getPlaylistIdFromOpenMedia(openMedia);

      if (kodiOpenMedia.movie) {
        label = kodiOpenMedia.movie.title;
        if (kodiOpenMedia.movie.imagesUrl) {
          poster = kodiOpenMedia.movie.imagesUrl.poster;
        }
      } else if (kodiOpenMedia.show) {
        label = kodiOpenMedia.show.title + ' S' + kodiOpenMedia.episode.seasonNumber.toString().padStart(2, '0');
        if (kodiOpenMedia.show.imagesUrl) {
          poster = kodiOpenMedia.show.imagesUrl.poster;
        }
      }
    }

    return {
      id,
      label,
      currentItem: 0,
      poster,
      updatedAt: new Date().toISOString(),
      items: [],
    } as Playlist;
  }

  async setPlaylist(source: StreamLinkSource | TorrentSource, kodiOpenMedia: KodiOpenMedia) {
    const playlist = this.getPlaylist(source.id, source.title, kodiOpenMedia);

    let savedPlaylist = await this.playListService.get(playlist.id);

    if (!savedPlaylist) {
      await this.playListService.addOrUpdate(playlist);
      savedPlaylist = await this.playListService.get(playlist.id);
    }

    return savedPlaylist;
  }

  private itemsAreEqual(item1: PlaylistVideo, item2: PlaylistVideo) {
    if (item1.openMedia && item2.openMedia) {
      if (
        item1.openMedia.showIds &&
        isSameId(item1.openMedia.showIds, item2.openMedia.showIds) &&
        item1.openMedia.seasonNumber === item2.openMedia.seasonNumber &&
        item1.openMedia.episodeNumber === item2.openMedia.episodeNumber
      ) {
        return true;
      } else if (item1.openMedia.movieIds && isSameId(item1.openMedia.movieIds, item2.openMedia.movieIds)) {
        return true;
      }
    }
    return item1.url === item2.url;
  }

  addItemToPlaylist({ playlist, item }: { playlist: Playlist; item: PlaylistVideo }) {
    // Check if the item is already in the playlist
    if (playlist.items.some((i) => this.itemsAreEqual(i, item))) {
      // update the item
      const index = playlist.items.findIndex((i) => this.itemsAreEqual(i, item));
      const oldItem = playlist.items[index];

      item.currentSeconds = oldItem.currentSeconds;
      playlist.items[index] = item;
    } else {
      playlist.items.push(item);
    }
  }

  async savePlaylist(playlist: Playlist) {
    this.removeDuplicateEntries(playlist);

    const res = await this.playListService.addOrUpdate(playlist);

    EventService.emit(EventCategory.playlist, EventName.change);

    return res;
  }

  private getId(url: string, openMedia: OpenMedia) {
    if (!openMedia) {
      return url;
    }

    let id = this.playListService.getPlaylistIdFromOpenMedia(openMedia);

    if (openMedia.seasonNumber) {
      id += `_S${openMedia.seasonNumber}`;
    }
    if (openMedia.episodeNumber) {
      id += `_E${openMedia.episodeNumber}`;
    }

    return id;
  }

  private removeDuplicateEntries(playlist: Playlist) {
    const items = [];
    const ids = [];
    playlist.items.forEach((item) => {
      const id = this.getId(item.url, item.openMedia);

      if (ids.includes(id)) {
        return;
      }
      ids.push(id);
      items.push(item);
    });

    playlist.items = items;
  }

  delete(playlist: Playlist) {
    this.playListService.delete(playlist.id);
  }
}
