import { InventoryItemService } from './items.js';
import { InventorySupplierService } from './suppliers.js';
import { InventoryPurchaseService } from './purchases.js';
import { InventoryMovementService } from './movements.js';

export class InventoryService {
  // Items
  static listInventoryItems = InventoryItemService.listInventoryItems;
  static getInventoryItemDetail = InventoryItemService.getInventoryItemDetail;
  static createInventoryItem = InventoryItemService.createInventoryItem;
  static updateInventoryItem = InventoryItemService.updateInventoryItem;
  static getReorderList = InventoryItemService.getReorderList;
  static commitCsvImport = InventoryItemService.commitCsvImport;
  static verifyStockConsistency = InventoryItemService.verifyStockConsistency;

  // Suppliers
  static listSuppliers = InventorySupplierService.listSuppliers;
  static createSupplier = InventorySupplierService.createSupplier;

  // Purchases
  static createPurchase = InventoryPurchaseService.createPurchase;
  static updatePurchase = InventoryPurchaseService.updatePurchase;
  static listPurchases = InventoryPurchaseService.listPurchases;

  // Movements
  static recordUsage = InventoryMovementService.recordUsage;
  static recordWaste = InventoryMovementService.recordWaste;
  static recordStockCount = InventoryMovementService.recordStockCount;
}

export {
  InventoryItemService,
  InventorySupplierService,
  InventoryPurchaseService,
  InventoryMovementService,
};

export default InventoryService;
