import { Request, Response, NextFunction } from 'express';

const mockGetAllContracts = jest.fn();
const mockCreateContract = jest.fn();
const mockGetContractsPage = jest.fn();

jest.mock('../services/contracts.service', () => {
  return {
    ContractsService: jest.fn().mockImplementation(() => {
      return {
        getAllContracts: mockGetAllContracts,
        createContract: mockCreateContract,
        getContractsPage: mockGetContractsPage,
      };
    }),
  };
});

import { ContractsController } from './contracts.controller';

describe('ContractsController', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      body: { title: 'Test Contract' },
      query: {},
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    mockGetAllContracts.mockClear();
    mockCreateContract.mockClear();
    mockGetContractsPage.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getContracts — happy paths
  // -------------------------------------------------------------------------

  describe('getContracts — success', () => {
    it('returns 200 with cursor page on first page (no cursor)', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 20 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(200);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: fakePage,
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('passes limit and cursor to service when provided', async () => {
      const fakePage = { data: [], nextCursor: null, hasNextPage: false, limit: 5 };
      mockGetContractsPage.mockResolvedValue(fakePage);

      // Build a valid base64url cursor
      const validCursor = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', id: 'abc-123' }),
        'utf8',
      ).toString('base64url');

      mockRequest.query = { limit: '5', cursor: validCursor };

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockGetContractsPage).toHaveBeenCalledWith({
        limit: 5,
        cursor: validCursor,
      });
      expect(mockResponse.status).toHaveBeenCalledWith(200);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — validation errors (400)
  // -------------------------------------------------------------------------

  describe('getContracts — validation errors', () => {
    it('returns 400 when limit exceeds 100', async () => {
      mockRequest.query = { limit: '101' };

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect((mockResponse.json as jest.Mock).mock.calls[0][0]).toMatchObject({
        status: 'error',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 400 when limit is 0', async () => {
      mockRequest.query = { limit: '0' };

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when limit is negative', async () => {
      mockRequest.query = { limit: '-1' };

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 for a malformed cursor', async () => {
      mockRequest.query = { cursor: 'not-a-valid-cursor' };

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
      expect((mockResponse.json as jest.Mock).mock.calls[0][0]).toMatchObject({
        status: 'error',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('returns 400 for a cursor missing the id field', async () => {
      const bad = Buffer.from(
        JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
        'utf8',
      ).toString('base64url');
      mockRequest.query = { cursor: bad };

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(400);
    });
  });

  // -------------------------------------------------------------------------
  // getContracts — error propagation
  // -------------------------------------------------------------------------

  describe('getContracts — error propagation', () => {
    it('calls next() when service throws', async () => {
      const mockError = new Error('DB Down');
      mockGetContractsPage.mockRejectedValue(mockError);

      await ContractsController.getContracts(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });

  // -------------------------------------------------------------------------
  // createContract
  // -------------------------------------------------------------------------

  describe('createContract', () => {
    it('returns 201 with the created contract', async () => {
      const fakeContract = { id: 'uuid-1', title: 'Test Contract' };
      mockCreateContract.mockResolvedValue(fakeContract);

      await ContractsController.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockResponse.status).toHaveBeenCalledWith(201);
      expect(mockResponse.json).toHaveBeenCalledWith({
        status: 'success',
        data: fakeContract,
      });
    });

    it('calls next() when service throws', async () => {
      const mockError = new Error('Creation failed');
      mockCreateContract.mockRejectedValue(mockError);

      await ContractsController.createContract(
        mockRequest as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(mockNext).toHaveBeenCalledWith(mockError);
    });
  });
});
