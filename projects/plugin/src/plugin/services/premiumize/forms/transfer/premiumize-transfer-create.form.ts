import { PremiumizeApiService } from '../../services/premiumize-api.service';
import { PremiumizeTransferCreateDto } from '../../dtos/transfer/premiumize-transfer-create.dto';

export class PremiumizeTransferCreateForm {
  static submit(torrentUrl: string) {
    return PremiumizeApiService.post<PremiumizeTransferCreateDto>('/transfer/create', {
      src: torrentUrl,
      folder_id: 'bx7fi3Y1rco_z12aQC148w',
    });
  }
}
