import { ExpenseCategoryService } from './categories.js';
import { ExpenseCrudService } from './expenses.js';
import { ExpenseReviewService } from './review.js';

export class ExpensesService {
  // Categories
  static listCategories = ExpenseCategoryService.listCategories;
  static createCategory = ExpenseCategoryService.createCategory;
  static updateCategory = ExpenseCategoryService.updateCategory;

  // Expenses CRUD & Recurring
  static listExpenses = ExpenseCrudService.listExpenses;
  static createExpense = ExpenseCrudService.createExpense;
  static updateExpense = ExpenseCrudService.updateExpense;
  static deleteExpense = ExpenseCrudService.deleteExpense;
  static copyRecurringExpenses = ExpenseCrudService.copyRecurringExpenses;

  // Monthly Review & Snapshots
  static getMonthlyReview = ExpenseReviewService.getMonthlyReview;
  static saveMonthlySnapshot = ExpenseReviewService.saveMonthlySnapshot;
  static listSnapshots = ExpenseReviewService.listSnapshots;
}

export { ExpenseCategoryService, ExpenseCrudService, ExpenseReviewService };
export default ExpensesService;
