/* eslint-disable no-unused-vars */
/* eslint-disable no-control-regex */
import * as azdev from 'azure-devops-node-api';
import * as TestInterfaces from 'azure-devops-node-api/interfaces/TestInterfaces';
import * as Test from 'azure-devops-node-api/TestApi';

import { FullConfig, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { WebApi } from 'azure-devops-node-api';
import { ICoreApi } from 'azure-devops-node-api/CoreApi';
import { TeamProject } from 'azure-devops-node-api/interfaces/CoreInterfaces';
import { TestPoint } from 'azure-devops-node-api/interfaces/TestInterfaces';
import chalk from 'chalk';
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { IRequestOptions } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';

export function createGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function shortID(): string {
  return crypto.randomBytes(8).toString('hex');
}

enum EAzureTestStatuses {
  passed = 'Passed',
  failed = 'Failed',
  skipped = 'Paused',
  timedOut = 'Failed',
  interrupted = 'Failed',
}

const attachmentTypesArray = ['screenshot', 'video', 'trace'] as const;

type TAttachmentType = Array<typeof attachmentTypesArray[number]>;
type TTestRunConfig = Omit<TestInterfaces.RunCreateModel, 'name' | 'automated' | 'plan' | 'pointIds'> | undefined;
type TTestPoint = {
  point: number | undefined;
  configurationId?: string;
  configurationName?: string;
  testCaseId: number;
};
type TTestResultsToBePublished = { test: ITestCaseExtended; testResult: TestResult };
type TPublishTestResults = 'testResult' | 'testRun';

interface ITestCaseExtended extends TestCase {
  testAlias: string;
  testCaseIds: string[];
}

export interface AzureReporterOptions {
  token: string;
  planId: number;
  orgUrl: string;
  projectName: string;
  publishTestResultsMode?: TPublishTestResults;
  logging?: boolean | undefined;
  isDisabled?: boolean | undefined;
  environment?: string | undefined;
  testRunTitle?: string | undefined;
  uploadAttachments?: boolean | undefined;
  attachmentsType?: TAttachmentType | undefined;
  testRunConfig?: TTestRunConfig;
  testRunConfigCallback?: (config: TTestRunConfig, suite: Suite) => TTestRunConfig;
}

interface TestResultsToTestRun {
  statusCode: number;
  result: Result;
  headers: Headers;
}
interface Result {
  count: number;
  value?: ValueEntity[] | null;
}
interface ValueEntity {
  id: number;
  project: Project;
  outcome: string;
  testRun: TestRun;
  priority: number;
  url: string;
  lastUpdatedBy: LastUpdatedBy;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface Project {}
interface TestRun {
  id: string;
}
interface LastUpdatedBy {
  displayName?: null;
  id?: null;
}
interface Headers {
  'cache-control': string;
  pragma: string;
  'content-length': string;
  'content-type': string;
  expires: string;
  p3p: string;
  'x-tfs-processid': string;
  'strict-transport-security': string;
  activityid: string;
  'x-tfs-session': string;
  'x-vss-e2eid': string;
  'x-vss-senderdeploymentid': string;
  'x-vss-userdata': string;
  'x-frame-options': string;
  'request-context': string;
  'access-control-expose-headers': string;
  'x-content-type-options': string;
  'x-cache': string;
  'x-msedge-ref': string;
  date: string;
  connection: string;
}

class TestRunWithConfiguration {
  config: TTestRunConfig;
  run: TestInterfaces.TestRun;

  constructor(config: TTestRunConfig, run: TestInterfaces.TestRun) {
    this.config = config;
    this.run = run;
  }
}

class AzureDevOpsReporter implements Reporter {
  private _testApi!: Test.ITestApi;
  private _coreApi!: ICoreApi;
  private _publishedResultsCount = 0;
  private _testsAliasToBePublished: string[] = [];
  private _testResultsToBePublished: TTestResultsToBePublished[] = [];
  private _connection!: WebApi;
  private _orgUrl!: string;
  private _projectName!: string;
  private _environment?: string;
  private _planId = 0;
  private _logging = false;
  private _isDisabled = false;
  private _testRunTitle = '';
  private _uploadAttachments = false;
  private _attachmentsType?: TAttachmentType;
  private _token: string = '';
  private _testRunPromise: Promise<TestRunWithConfiguration | void>;
  private _resolveTestRun: (value: TestRunWithConfiguration) => void = () => {};
  private _rejectTestRun: (reason: any) => void = () => {};
  private _publishResultsPromise: Promise<any | void>;
  private _resolvePublishResults: () => void = () => {};
  private _rejectPublishResults: (reason: any) => void = () => {};
  private _suite!: Suite;
  private _testRunConfigBlueprint: TTestRunConfig = {} as TTestRunConfig;
  private _testRunConfigCallback: (config: TTestRunConfig, suite: Suite) => TTestRunConfig = (config, _) => config;
  private _azureClientOptions = {
    allowRetries: true,
    maxRetries: 20,
  } as IRequestOptions;
  private _publishTestResultsMode: TPublishTestResults = 'testResult';

  public constructor(options: AzureReporterOptions) {
    this._testRunPromise = new Promise<TestRunWithConfiguration | void>((resolve, reject) => {
      this._resolveTestRun = resolve;
      this._rejectTestRun = reject;
    })
      .then((runId) => {
        return runId;
      })
      .catch((error) => {
        this._warning(error);
        this._isDisabled = true;
      });
    this._publishResultsPromise = new Promise<void>((resolve, reject) => {
      this._resolvePublishResults = resolve;
      this._rejectPublishResults = reject;
    })
      .then((runId) => {
        return runId;
      })
      .catch((error) => {
        this._warning(error);
        this._isDisabled = true;
      });
    this._validateOptions(options);
  }

  _validateOptions(options: AzureReporterOptions): void {
    if (options?.isDisabled) {
      this._isDisabled = true;
      return;
    }
    if (!options?.orgUrl) {
      this._warning("'orgUrl' is not set. Reporting is disabled.");
      this._isDisabled = true;
      return;
    }
    if (!options?.projectName) {
      this._warning("'projectName' is not set. Reporting is disabled.");
      this._isDisabled = true;
      return;
    }
    if (!options?.planId) {
      this._warning("'planId' is not set. Reporting is disabled.");
      this._isDisabled = true;
      return;
    }
    if (!options?.token) {
      this._warning("'token' is not set. Reporting is disabled.");
      this._isDisabled = true;
      return;
    }
    if (options?.uploadAttachments) {
      if (!options?.attachmentsType) {
        this._warning("'attachmentsType' is not set. Attachments Type will be set to 'screenshot' by default.");
        this._attachmentsType = ['screenshot'];
      } else {
        this._attachmentsType = options.attachmentsType;
      }
    }

    this._orgUrl = options.orgUrl;
    this._projectName = options.projectName;
    this._planId = options.planId;
    this._logging = options.logging || false;
    this._token = options.token;
    this._environment = options?.environment || undefined;
    this._testRunTitle =
      `${this._environment ? `[${this._environment}]:` : ''} ${options?.testRunTitle || 'Playwright Test Run'}` ||
      `${this._environment ? `[${this._environment}]:` : ''}Test plan ${this._planId}`;
    this._uploadAttachments = options?.uploadAttachments || false;
    this._connection = new azdev.WebApi(
      this._orgUrl,
      azdev.getPersonalAccessTokenHandler(this._token),
      this._azureClientOptions
    );
    if (options?.testRunConfigCallback) {
      this._testRunConfigCallback = options?.testRunConfigCallback;
    }
    this._testRunConfigBlueprint = options?.testRunConfig || undefined;
    this._publishTestResultsMode = options?.publishTestResultsMode || 'testResult';
  }

  async onBegin(fullConfig: FullConfig, suite: Suite): Promise<void> {
    this._suite = suite;

    if (this._isDisabled) return;
    try {
      this._testApi = await this._connection.getTestApi();

      if (this._publishTestResultsMode === 'testResult') {

        const run = await this._createRun(this._suite, this._testRunTitle);
        if (run) {
          this._resolveTestRun(run);
          this._log(chalk.green(`Using run ${run.run.id} to publish test results`));
        } else {
          this._isDisabled = true;
          this._rejectTestRun('Failed to create test run. Reporting is disabled.');
        }
      }
    } catch (error: any) {
      this._isDisabled = true;
      if (error.message.includes('401')) {
        this._warning('Failed to create test run. Check your token. Reporting is disabled.');
      } else if (error.message.includes('getaddrinfo ENOTFOUND')) {
        this._warning('Failed to create test run. Check your orgUrl. Reporting is disabled.');
      } else {
        this._warning('Failed to create test run. Reporting is disabled.');
        const parsedError = JSON.parse(String(error.message.trim()));
        this._warning(parsedError?.message || error.message);
      }
    }
  }

  async onTestEnd(test: TestCase, testResult: TestResult): Promise<void> {
    if (this._isDisabled) return;
    try {
      if (this._publishTestResultsMode === 'testResult') {
        const testRun = await this._testRunPromise;

        if (!testRun) return;

        this._logTestItem(test, testResult);
        await this._publishCaseResult(testRun, test, testResult);
      } else {
        this._logTestItem(test, testResult);
        const testCase: ITestCaseExtended = {
          ...test,
          testAlias: `${shortID()} - ${test.title}`,
          testCaseIds: this._getCaseIds(test),
        };
        this._testResultsToBePublished.push({ test: testCase, testResult });
      }
    } catch (error: any) {
      this._warning(`Failed to publish test result. \n ${error.message}`);
    }
  }

  async onEnd(): Promise<void> {
    if (this._isDisabled) return;
    try {
      let testRun: TestRunWithConfiguration | void;

      if (this._publishTestResultsMode === 'testResult') {
        testRun = await this._testRunPromise;

        let prevCount = this._testsAliasToBePublished.length;
        while (this._testsAliasToBePublished.length > 0) {
          // need wait all results to be published
          if (prevCount > this._testsAliasToBePublished.length) {
            this._log(
              chalk.gray(
                `Waiting for all results to be published. Remaining ${this._testsAliasToBePublished.length} results`
              )
            );
            prevCount--;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } else {
        this._logging = true;

        testRun = await this._createRun(this._suite, this._testRunTitle);

        if (testRun) {
          this._resolveTestRun(testRun);
          this._log(chalk.green(`Using run ${testRun.run.id} to publish test results`));
          await this._publishTestResults(testRun, this._testResultsToBePublished);
        } else {
          this._isDisabled = true;
          this._rejectTestRun('Failed to create test run. Reporting is disabled.');
        }

        await this._publishResultsPromise;
      }

      if (this._publishedResultsCount === 0 && !testRun) {
        this._log(chalk.gray('No testcases were matched. Ensure that your tests are declared correctly.'));
        return;
      }

      if (!this._testApi) this._testApi = await this._connection.getTestApi();
      const runUpdatedResponse = await this._testApi.updateTestRun({ state: 'Completed' }, this._projectName, testRun?.run.id!);
      this._log(chalk.green(`Run ${testRun} - ${runUpdatedResponse.state}`));
    } catch (error: any) {
      this._warning(chalk.red(`Error on completing run ${error as string}`));
    }
  }

  printsToStdio(): boolean {
    return true;
  }

  private _log(message: any) {
    if (this._logging) {
      console.log(chalk.magenta(`azure: ${message}`));
    }
  }

  private _warning(message: any) {
    console.log(`${chalk.magenta('azure:')} ${chalk.yellow(message)}`);
  }

  private _getCaseIds(test: TestCase): string[] {
    const result: string[] = [];
    const regex = new RegExp(/\[([\d,\s]+)\]/, 'gm');
    const matchesAll = test.title.matchAll(regex);
    const matches = [...matchesAll].map((match) => match[1]);
    matches.forEach((match) => {
      const ids = match.split(',').map((id) => id.trim());
      result.push(...ids);
    });
    return result;
  }

  private _logTestItem(test: TestCase, testResult: TestResult) {
    switch (testResult.status) {
      case 'passed':
        this._log(chalk.green(`${test.title} - ${testResult.status}`));
        break;
      case 'failed':
        this._log(chalk.red(`${test.title} - ${testResult.status}`));
        break;
      case 'timedOut':
        this._log(chalk.yellow(`${test.title} - ${testResult.status}`));
        break;
      case 'skipped':
        this._log(chalk.yellow(`${test.title} - ${testResult.status}`));
        break;
      case 'interrupted':
        this._log(chalk.red(`${test.title} - ${testResult.status}`));
        break;
      default:
        this._log(`${test.title} - ${testResult.status}`);
        break;
    }
  }

  private async _createRun(suite: Suite, runName: string): Promise<TestRunWithConfiguration | void> {
    try {
      const isExists = await this._checkProject(this._projectName);
      if (!isExists) {
        return;
      } else {
        const testRunConfig = this._testRunConfigCallback(this._testRunConfigBlueprint, suite);
        const runModel: TestInterfaces.RunCreateModel = {
          name: runName,
          automated: true,
          plan: { id: String(this._planId) },
          ...(testRunConfig
            ? testRunConfig
            : {
                configurationIds: [1],
              }),
        };
        if (!this._testApi) this._testApi = await this._connection.getTestApi();
        const adTestRun = await this._testApi.createTestRun(runModel, this._projectName);
        if (adTestRun?.id) return new TestRunWithConfiguration(testRunConfig, adTestRun);
        else throw new Error('Failed to create test run');
      }
    } catch (error: any) {
      this._warning(chalk.red(error.message));
      this._isDisabled = true;
    }
  }

  private _removePublished(testAlias: string): void {
    const resultIndex = this._testsAliasToBePublished.indexOf(testAlias);
    if (resultIndex !== -1) this._testsAliasToBePublished.splice(resultIndex, 1);
  }

  private async _checkProject(projectName: string): Promise<TeamProject | void> {
    try {
      if (!this._coreApi) this._coreApi = await this._connection.getCoreApi();
      const project = await this._coreApi.getProject(projectName);
      if (project) return project;
      else throw new Error(`Project ${projectName} does not exist. Reporting is disabled.`);
    } catch (error: any) {
      this._warning(chalk.red(error.message));
      this._isDisabled = true;
    }
  }

  private async _getTestPointIdByTCId(testRun: TestRunWithConfiguration, planId: number, testcaseId: number): Promise<TTestPoint> {
    const result = {} as TTestPoint;
    try {
      const pointsQuery: TestInterfaces.TestPointsQuery = {
        pointsFilter: { testcaseIds: [testcaseId] },
      };
      if (!this._testApi) this._testApi = await this._connection.getTestApi();
      const pointsQueryResult: TestInterfaces.TestPointsQuery = await this._testApi.getPointsByQuery(
        pointsQuery,
        this._projectName
      );
      if (pointsQueryResult.points) {
        const findedPointWithConfiguration = pointsQueryResult.points.find(
          (point) =>
            point.testPlan &&
            point.testPlan.id &&
            parseInt(point.testPlan.id, 10) === planId &&
            (testRun.config?.configurationIds?.length
              ? testRun.config.configurationIds.includes(Number(point.configuration.id))
              : false)
        );
        if (findedPointWithConfiguration) {
          result.point = findedPointWithConfiguration.id;
          result.configurationId = findedPointWithConfiguration.configuration.id!;
          result.configurationName = findedPointWithConfiguration.configuration.name!;
        } else {
          const findedPoint = pointsQueryResult.points.find(
            (point) => point.testPlan && point.testPlan.id && parseInt(point.testPlan.id, 10) === planId
          );
          if (findedPoint) {
            result.point = findedPoint.id;
          }
        }
      }
      if (!result?.point) {
        throw new Error(
          `Could not find test point for test cases [${testcaseId}] associated with test plan ${this._planId}. Check, maybe testPlanId, what you specified, is incorrect.`
        );
      }
    } catch (error: any) {
      this._warning(chalk.red(error.message));
    }
    return result;
  }

  private async _getTestPointIdsByTCIds(testRun: TestRunWithConfiguration, planId: number, testcaseIds: number[]): Promise<TTestPoint[]> {
    const result = [] as TTestPoint[];
    try {
      const pointsQuery: TestInterfaces.TestPointsQuery = {
        pointsFilter: { testcaseIds: testcaseIds },
      };
      if (!this._testApi) this._testApi = await this._connection.getTestApi();
      const pointsQueryResult: TestInterfaces.TestPointsQuery = await this._testApi.getPointsByQuery(
        pointsQuery,
        this._projectName
      );
      testcaseIds.forEach((testcaseId) => {
        if (pointsQueryResult.points) {
          const findedPointWithConfiguration = pointsQueryResult.points.find(
            (point) =>
              point.testCase.id === testcaseId.toString() &&
              point.testPlan &&
              point.testPlan.id &&
              parseInt(point.testPlan.id, 10) === planId &&
              (testRun.config?.configurationIds?.length
                ? testRun.config.configurationIds.includes(Number(point.configuration.id))
                : false)
          );
          if (findedPointWithConfiguration) {
            result.push({
              testCaseId: testcaseId,
              point: findedPointWithConfiguration.id,
              configurationId: findedPointWithConfiguration.configuration.id!,
              configurationName: findedPointWithConfiguration.configuration.name!,
            });
          } else {
            const findedPoint = pointsQueryResult.points.find(
              (point) =>
                point.testCase.id === testcaseId.toString() &&
                point.testPlan &&
                point.testPlan.id &&
                parseInt(point.testPlan.id, 10) === planId
            );
            if (findedPoint) {
              result.push({
                testCaseId: testcaseId,
                point: findedPoint.id,
              });
            }
          }
        }
      });
      if (!result?.some((item) => item.point)) {
        this._warning(
          `Could not find test point for test cases [${testcaseIds.join(',')}] associated with test plan ${
            this._planId
          }. Check, maybe testPlanId, what you specified, is incorrect.`
        );
      }
    } catch (error: any) {
      this._warning(chalk.red(error.message));
    }
    return result;
  }

  private _addReportingOverride = (api: Test.ITestApi): Test.ITestApi => {
    /**
     * Override the default behavior of publishing test results to the test run.
     * This is necessary because Microsoft Azure API documentation at version higher than '5.0-preview.5'
     * has undocumented fields and they not implementing at 'azure-devops-node-api/TestApi' package.
     * This function is downgraded the API version to '5.0-preview.5'.
     * https://github.com/microsoft/azure-devops-node-api/issues/318#issuecomment-498802402
     */
    api.addTestResultsToTestRun = function (results, projectName, runId) {
      return new Promise(async (resolve, reject) => {
        const routeValues = {
          project: projectName,
          runId,
        };

        try {
          const verData = await this.vsoClient.getVersioningData(
            '5.0-preview.5',
            'Test',
            '4637d869-3a76-4468-8057-0bb02aa385cf',
            routeValues
          );
          const url = verData.requestUrl;
          const options = this.createRequestOptions('application/json', verData.apiVersion);
          const res = await this.rest.create(url as string, results, options);
          resolve(res as any);
        } catch (error) {
          reject(error);
        }
      });
    };
    return api;
  };

  private async _uploadAttachmentsFunc(
    testResult: TestResult,
    testCaseResultId: number,
    test: ITestCaseExtended | TestCase
  ): Promise<string[]> {
    this._log(chalk.gray(`Uploading attachments for test: ${test.title}`));
    const testRun = await this._testRunPromise;
    const attachmentsResult: string[] = [];

    if (!testRun) {
      throw new Error('Could not find test run id. Check, maybe testPlanId, what you specified, is incorrect.');
    }

    for (const attachment of testResult.attachments) {
      try {
        if (this._attachmentsType!.includes(attachment.name as TAttachmentType[number])) {
          if (existsSync(attachment.path!)) {
            const attachmentRequestModel: TestInterfaces.TestAttachmentRequestModel = {
              attachmentType: 'GeneralAttachment',
              fileName: `${attachment.name}-${createGuid()}.${attachment.contentType.split('/')[1]}`,
              stream: readFileSync(attachment.path!, { encoding: 'base64' }),
            };

            if (!this._testApi) this._testApi = await this._connection.getTestApi();
            const response = await this._testApi.createTestResultAttachment(
              attachmentRequestModel,
              this._projectName,
              testRun.run.id!,
              testCaseResultId
            );
            if (!response?.id) throw new Error(`Failed to upload attachment for test: ${test.title}`);
            attachmentsResult.push(response.url);
          } else {
            throw new Error(`Attachment ${attachment.path} does not exist`);
          }
        }
      } catch (error: any) {
        this._log(chalk.red(error.message));
      }
    }
    this._log(chalk.gray('Uploaded attachments'));
    return attachmentsResult;
  }

  private async _publishCaseResult(testRun: TestRunWithConfiguration, test: TestCase, testResult: TestResult): Promise<TestResultsToTestRun | void> {
    const caseIds = this._getCaseIds(test);
    if (!caseIds || !caseIds.length) return;

    await Promise.all(
      caseIds.map(async (caseId) => {
        const testAlias = `${shortID()} - ${test.title}`;
        this._testsAliasToBePublished.push(testAlias);
        try {
          this._log(chalk.gray(`Start publishing: TC:${caseId} - ${test.title}`));

          const points = await this._getTestPointIdByTCId(testRun, this._planId as number, parseInt(caseId, 10));
          if (!points.point) {
            this._removePublished(testAlias);
            throw new Error(`No test points found for test case [${caseIds}]`);
          }
          const results: TestInterfaces.TestCaseResult[] = [
            {
              testCase: { id: caseId },
              testPoint: { id: String(points.point) },
              testCaseTitle: test.title,
              outcome: EAzureTestStatuses[testResult.status],
              state: 'Completed',
              durationInMs: testResult.duration,
              errorMessage: testResult.error
                ? `${test.title}: ${testResult.error?.message?.replace(/\u001b\[.*?m/g, '') as string}`
                : undefined,
              stackTrace: testResult.error?.stack?.replace(/\u001b\[.*?m/g, ''),
              ...(points.configurationId && {
                configuration: { id: points.configurationId, name: points.configurationName },
              }),
            },
          ];

          if (!this._testApi) this._testApi = await this._connection.getTestApi();
          const testCaseResult: TestResultsToTestRun = (await this._addReportingOverride(
            this._testApi
          ).addTestResultsToTestRun(results, this._projectName, testRun?.run.id!)) as unknown as TestResultsToTestRun;
          if (!testCaseResult?.result) throw new Error(`Failed to publish test result for test case [${caseId}]`);
          
          if (this._uploadAttachments && testResult.attachments.length > 0)
            await this._uploadAttachmentsFunc(testResult, testCaseResult.result.value![0].id, test);

          this._removePublished(testAlias);
          this._publishedResultsCount++;
          this._log(chalk.gray(`Result published: TC:${caseId} - ${test.title}`));
          return testCaseResult;
        } catch (error: any) {
          this._removePublished(testAlias);
          this._warning(chalk.red(error.message));
        }
      })
    );
  }

  private async _publishTestResults(testRun: TestRunWithConfiguration, testsResults: TTestResultsToBePublished[]) {
    if (!this._testApi) this._testApi = await this._connection.getTestApi();

    const testsPackSize = 50;
    const testsEndPack = Math.ceil(testsResults.length / testsPackSize);
    const testsPacksArray = Array.from({ length: testsEndPack }, (_, i) =>
      testsResults.slice(i * testsPackSize, (i + 1) * testsPackSize)
    );

    this._log(chalk.gray(`Start publishing test results for ${testsResults.length} test(s)`));

    try {
      for (const testsPack of testsPacksArray) {
        let testCaseIds: string[] = [];
        const testsPoints = await this._getTestPointIdsByTCIds(testRun, this._planId as number, [
          ...new Set(testsPack.map((t) => t.test.testCaseIds.map((id) => parseInt(id, 10))).flat()),
        ]);
        const testCaseResults: TestInterfaces.TestCaseResult[] = [];

        for (const { test, testResult } of testsPack) {
          testCaseIds = test.testCaseIds;

          for (const id of testCaseIds) {
            const testPoint = testsPoints.find((p) => p.testCaseId === parseInt(id, 10));

            if (!testPoint) {
              this._warning(`No test points found for test case [${testCaseIds}]`);
            } else {
              testCaseResults.push({
                testCase: { id },
                testPoint: { id: String(testPoint.point) },
                testCaseTitle: test.title,
                outcome: EAzureTestStatuses[testResult.status],
                state: 'Completed',
                durationInMs: testResult.duration,
                errorMessage: testResult.error
                  ? `${test.title}: ${testResult.error?.message?.replace(/\u001b\[.*?m/g, '') as string}`
                  : undefined,
                stackTrace: testResult.error?.stack?.replace(/\u001b\[.*?m/g, ''),
                ...(testPoint.configurationId && {
                  configuration: { id: testPoint.configurationId, name: testPoint.configurationName },
                }),
              });
            }
          }
        }

        if (testCaseResults.length === 0) {
          continue;
        }

        const testCaseResult: TestResultsToTestRun = (await this._addReportingOverride(
          this._testApi
        ).addTestResultsToTestRun(testCaseResults, this._projectName, testRun.run.id!)) as unknown as TestResultsToTestRun;

        if (!testCaseResult.result) {
          this._warning(`Failed to publish test result for test case [${testCaseIds.join(', ')}]`);
        }

        const testsWithAttachments = testsPack.filter((t) => t.testResult.attachments.length > 0);
        if (this._uploadAttachments && testsWithAttachments.length > 0) {
          this._log(chalk.gray(`Starting to uploading attachments for ${testsWithAttachments.length} test(s)`));
        }

        if (this._uploadAttachments && testsWithAttachments?.length > 0) {
          const testResultsQuery: TestInterfaces.TestResultsQuery = {
            fields: [''],
            results: testCaseResult.result.value?.map((r) => {
              return { id: r.id, testRun: { id: r.testRun?.id } };
            }),
          };

          const resultData = await this._testApi.getTestResultsByQuery(testResultsQuery, this._projectName);

          for (const publishedTestResult of resultData.results!) {
            const testWithAttachments = testsWithAttachments.find((t) =>
              t.test.testCaseIds.includes(publishedTestResult.testCase?.id as string)
            );

            if (testWithAttachments) {
              await this._uploadAttachmentsFunc(
                testWithAttachments.testResult,
                publishedTestResult.id!,
                testWithAttachments.test
              );
            }
          }
        }

        this._publishedResultsCount += testsPack.length;
        this._log(chalk.gray(`Left to publish: ${testsResults.length - this._publishedResultsCount}`));
      }
      this._log(chalk.gray(`Test results published for ${this._publishedResultsCount} test(s)`));
      this._resolvePublishResults();
    } catch (error: any) {
      this._warning(chalk.red(error.message));
      this._rejectPublishResults(error);
    }
  }
}

export default AzureDevOpsReporter;
