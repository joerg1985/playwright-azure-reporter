/* eslint-disable no-unused-vars */
/* eslint-disable no-control-regex */
import * as azdev from 'azure-devops-node-api'
import * as TestInterfaces from 'azure-devops-node-api/interfaces/TestInterfaces'
import * as Test from 'azure-devops-node-api/TestApi'

import { Reporter, TestCase, TestResult } from '@playwright/test/reporter'

import { WebApi } from 'azure-devops-node-api'
import { ICoreApi } from 'azure-devops-node-api/CoreApi'
import { TeamProject } from 'azure-devops-node-api/interfaces/CoreInterfaces'
import { TestPoint } from 'azure-devops-node-api/interfaces/TestInterfaces'
import chalk from 'chalk'
import crypto from 'crypto'
import { existsSync, readFileSync } from 'fs'

export function createGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

enum AzureTestStatuses {
  passed = 'Passed',
  failed = 'Failed',
  skipped = 'Paused',
  timedOut = 'Failed',
  interrupted = 'Failed',
}

const attachmentTypesArray = [
  'screenshot',
  'video',
  'trace',
] as const;

type TAttachmentType = Array<typeof attachmentTypesArray[number]>;
type TTestRunConfig = Omit<TestInterfaces.RunCreateModel, 'name' | 'automated' | 'plan' | 'pointIds'>;

export interface AzureReporterOptions {
  token: string;
  planId: number;
  orgUrl: string;
  projectName: string;
  logging?: boolean | undefined;
  isDisabled?: boolean | undefined;
  environment?: string | undefined;
  testRunTitle?: string | undefined;
  uploadAttachments?: boolean | undefined;
  attachmentsType?: TAttachmentType | undefined;
  testRunConfig?: TTestRunConfig;
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
interface Project {
}
interface TestRun {
  id: string;
}
interface LastUpdatedBy {
  displayName?: null;
  id?: null;
}
interface Headers {
  'cache-control': string;
  'pragma': string;
  'content-length': string;
  'content-type': string;
  'expires': string;
  'p3p': string;
  'x-tfs-processid': string;
  'strict-transport-security': string;
  'activityid': string;
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
  'date': string;
  'connection': string;
}

class AzureDevOpsReporter implements Reporter {
  private testApi!: Test.ITestApi;
  private coreApi!: ICoreApi;
  private publishedResultsCount = 0;
  private resultsToBePublished: string[] = [];
  private connection!: WebApi;
  private orgUrl!: string;
  private projectName!: string;
  private environment?: string;
  private planId = 0;
  private logging = false;
  private isDisabled = false;
  private testRunTitle = '';
  private uploadAttachments = false;
  private attachmentsType?: TAttachmentType;
  private token: string = '';
  private runIdPromise: Promise<number | void>;
  private resolveRunId: (value: number) => void = () => { };
  private rejectRunId: (reason: any) => void = () => { };
  private testRunConfig: TTestRunConfig = {} as TTestRunConfig;

  public constructor(options: AzureReporterOptions) {
    this.runIdPromise = new Promise<number | void>((resolve, reject) => {
      this.resolveRunId = resolve;
      this.rejectRunId = reject;
    }).then(runId => {
      return runId;
    }).catch(error => {
      this._warning(error);
      this.isDisabled = true;
    });
    this._validateOptions(options);
  }

  _validateOptions(options: AzureReporterOptions): void {
    if (options?.isDisabled) {
      this.isDisabled = true;
      return;
    }
    if (!options?.orgUrl) {
      this._warning("'orgUrl' is not set. Reporting is disabled.");
      this.isDisabled = true;
      return;
    }
    if (!options?.projectName) {
      this._warning("'projectName' is not set. Reporting is disabled.");
      this.isDisabled = true;
      return;
    }
    if (!options?.planId) {
      this._warning("'planId' is not set. Reporting is disabled.");
      this.isDisabled = true;
      return;
    }
    if (!options?.token) {
      this._warning("'token' is not set. Reporting is disabled.");
      this.isDisabled = true;
      return;
    }
    if (options?.uploadAttachments) {
      if (!options?.attachmentsType) {
        this._warning("'attachmentsType' is not set. Attachments Type will be set to 'screenshot' by default.");
        this.attachmentsType = ['screenshot'];
      } else {
        this.attachmentsType = options.attachmentsType;
      }
    }

    this.orgUrl = options.orgUrl;
    this.projectName = options.projectName;
    this.planId = options.planId;
    this.logging = options.logging || false;
    this.token = options.token;
    this.environment = options?.environment || undefined;
    this.testRunTitle = `${this.environment ? `[${this.environment}]:` : ''} ${options?.testRunTitle || 'Playwright Test Run'}` ||
      `${this.environment ? `[${this.environment}]:` : ''}Test plan ${this.planId}`;
    this.uploadAttachments = options?.uploadAttachments || false;
    this.connection = new azdev.WebApi(this.orgUrl, azdev.getPersonalAccessTokenHandler(this.token));
    this.testRunConfig = options?.testRunConfig || {
      configurationIds: [1],
    }
  }

  async onBegin(): Promise<void> {
    if (this.isDisabled)
      return;
    try {
      this.testApi = await this.connection.getTestApi();

      const run = await this._createRun(this.testRunTitle);
      if (run?.id) {
        this.resolveRunId(run.id);
        this._log(chalk.green(`Using run ${run.id} to publish test results`));
      } else {
        this.isDisabled = true;
        this.rejectRunId('Failed to create test run. Reporting is disabled.');
      }
    } catch (error: any) {
      this.isDisabled = true;
      if (error.message.includes('401')) {
        this._warning('Failed to create test run. Check your token. Reporting is disabled.');
      } else if (error.message.includes('getaddrinfo ENOTFOUND')) {
        this._warning('Failed to create test run. Check your orgUrl. Reporting is disabled.');
      } else {
        this._warning('Failed to create test run. Reporting is disabled.');
        const parsedError = JSON.parse(String(error.message.trim()))
        this._warning(parsedError?.message || error.message);
      }
    }
  }

  async onTestEnd(test: TestCase, testResult: TestResult): Promise<void> {
    if (this.isDisabled)
      return;
    try {
      const runId = await this.runIdPromise;

      if (!runId)
        return;

      this._logTestItem(test, testResult);
      await this._publishCaseResult(test, testResult);

    } catch (error: any) {
      this._warning(`Failed to publish test result. \n ${error.message}`);
    }
  }

  async onEnd(): Promise<void> {
    if (this.isDisabled)
      return;
    try {
      const runId = await this.runIdPromise;

      let prevCount = this.resultsToBePublished.length;
      while (this.resultsToBePublished.length > 0) {
        // need wait all results to be published
        if (prevCount > this.resultsToBePublished.length) {
          this._log(
            chalk.gray(`Waiting for all results to be published. Remaining ${this.resultsToBePublished.length} results`)
          );
          prevCount--;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }

      if (this.publishedResultsCount === 0 && !runId) {
        this._log(chalk.gray('No testcases were matched. Ensure that your tests are declared correctly.'));
        return;
      }

      if (!this.testApi)
        this.testApi = await this.connection.getTestApi();
      const runUpdatedResponse = await this.testApi.updateTestRun({ state: 'Completed' }, this.projectName, runId!);
      this._log(chalk.green(`Run ${runId} - ${runUpdatedResponse.state}`));
    } catch (error: any) {
      this._warning(chalk.red(`Error on completing run ${error as string}`));
    }
  }

  printsToStdio(): boolean {
    return true;
  }

  private _log(message: any) {
    if (this.logging) {
      console.log(chalk.magenta(`azure: ${message}`));
    }
  }

  private _warning(message: any) {
    console.log(`${chalk.magenta('azure:')} ${chalk.yellow(message)}`);
  }
  
  private _getCaseIds(test: TestCase): string | undefined {
    const results = /\[([\d,]+)\]/.exec(test.title);
    if (results && results.length === 2)
      return results[1];
  }

  private _logTestItem(test: TestCase, testResult: TestResult) {
    switch (testResult.status) {
      case 'passed': this._log(chalk.green(`${test.title} - ${testResult.status}`)); break;
      case 'failed': this._log(chalk.red(`${test.title} - ${testResult.status}`)); break;
      case 'timedOut': this._log(chalk.yellow(`${test.title} - ${testResult.status}`)); break;
      case 'skipped': this._log(chalk.yellow(`${test.title} - ${testResult.status}`)); break;
      case 'interrupted': this._log(chalk.red(`${test.title} - ${testResult.status}`)); break;
      default: this._log(`${test.title} - ${testResult.status}`); break;
    }
  }

  private async _createRun(runName: string): Promise<TestInterfaces.TestRun | void> {
    try {
      const isExists = await this._checkProject(this.projectName);
      if (!isExists) {
        return;
      } else {
        const runModel: TestInterfaces.RunCreateModel = {
          name: runName,
          automated: true,
          plan: { id: String(this.planId) },
          ...this.testRunConfig,
        };
        if (!this.testApi)
          this.testApi = await this.connection.getTestApi();
        const adTestRun = await this.testApi.createTestRun(runModel, this.projectName);
        if (adTestRun?.id)
          return adTestRun;
        else
          throw new Error('Failed to create test run');
      }
    } catch (error: any) {
      this._warning(chalk.red(error.message));
      this.isDisabled = true;
    }
  }

  private _removePublished(testAlias: string): void {
    const resultIndex = this.resultsToBePublished.indexOf(testAlias);
    if (resultIndex !== -1)
      this.resultsToBePublished.splice(resultIndex, 1);
  }

  private async _checkProject(projectName: string): Promise<TeamProject | void> {
    try {
      if (!this.coreApi)
        this.coreApi = await this.connection.getCoreApi();
      const project = await this.coreApi.getProject(projectName);
      if (project)
        return project;
      else
        throw new Error(`Project ${projectName} does not exist. Reporting is disabled.`);

    } catch (error: any) {
      this._warning(chalk.red(error.message));
      this.isDisabled = true;
    }
  }

  private async _getTestPointIdsByTCIds(planId: number, testcaseIds: number[]): Promise<number[]> {
    const pointsIds: number[] = [];
    try {
      const pointsQuery: TestInterfaces.TestPointsQuery = {
        pointsFilter: { testcaseIds }
      };
      if (!this.testApi)
        this.testApi = await this.connection.getTestApi();
      const pointsQueryResult: TestInterfaces.TestPointsQuery = await this.testApi.getPointsByQuery(
        pointsQuery,
        this.projectName
      );
      if (pointsQueryResult.points) {
        pointsQueryResult.points.forEach((point: TestPoint) => {
          if (point.testPlan && point.testPlan.id && parseInt(point.testPlan.id, 10) === planId) {
            pointsIds.push(point.id);
          }
        });
      }
      if (pointsIds.length === 0) {
        throw new Error(`Could not find test point for test cases [${testcaseIds.join(',')}] associated with test plan ${this.planId}. Check, maybe testPlanId, what you specified, is incorrect.`);
      }
      return pointsIds;
    } catch (error: any) {
      this._warning(chalk.red(error.message));
    }
    return pointsIds;
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
          runId
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

  private async _uploadAttachmentsFunc(testResult: TestResult, caseId: number, testCaseId: string): Promise<string[]> {
    this._log(chalk.gray(`Start upload attachments for test case [${testCaseId}]`));
    const runId = await this.runIdPromise;
    const attachmentsResult: string[] = [];
    for (const attachment of testResult.attachments) {
      try {
        if (this.attachmentsType!.includes((attachment.name as TAttachmentType[number]))) {
          if (existsSync(attachment.path!)) {
            const attachments: TestInterfaces.TestAttachmentRequestModel = {
              attachmentType: 'GeneralAttachment',
              fileName: `${attachment.name}-${createGuid()}.${attachment.contentType.split('/')[1]}`,
              stream: readFileSync(attachment.path!, { encoding: 'base64' })
            };

            if (!this.testApi)
              this.testApi = await this.connection.getTestApi();
            const response = await this.testApi.createTestResultAttachment(
              attachments,
              this.projectName,
              runId!,
              caseId
            );
            if (!response?.id) throw new Error(`Failed to upload attachment for test case [${testCaseId}]`);
            attachmentsResult.push(response.url);
          } else {
            throw new Error(`Attachment ${attachment.path} does not exist`);
          }
        }
      } catch (error: any) {
        this._log(chalk.red(error.message));
      }
    }
    return attachmentsResult;
  }

  private async _publishCaseResult(test: TestCase, testResult: TestResult): Promise<TestResultsToTestRun | void> {
    const caseId = this._getCaseIds(test);
    if (!caseId)
      return;

    const testAlias = `${caseId} - ${test.title}`;
    this.resultsToBePublished.push(testAlias);
    try {
      const runId = await this.runIdPromise;
      this._log(chalk.gray(`Start publishing: ${test.title}`));

      const pointIds = await this._getTestPointIdsByTCIds(this.planId as number, [parseInt(caseId, 10)]);
      if (!pointIds || !pointIds.length) {
        this._removePublished(testAlias);
        throw new Error(`No test points found for test case [${caseId}]`);
      }
      const results: TestInterfaces.TestCaseResult[] = [
        {
          testCase: { id: caseId },
          testPoint: { id: String(pointIds[0]) },
          testCaseTitle: test.title,
          outcome: AzureTestStatuses[testResult.status],
          state: 'Completed',
          durationInMs: testResult.duration,
          errorMessage: testResult.error
            ? `${test.title}: ${testResult.error?.message?.replace(/\u001b\[.*?m/g, '') as string}`
            : undefined,
          stackTrace: testResult.error?.stack?.replace(/\u001b\[.*?m/g, '')
        }
      ];

      if (!this.testApi)
        this.testApi = await this.connection.getTestApi();
      const testCaseResult: TestResultsToTestRun = await this._addReportingOverride(this.testApi).addTestResultsToTestRun(results, this.projectName, runId!) as unknown as TestResultsToTestRun;
      if (!testCaseResult?.result) throw new Error(`Failed to publish test result for test case [${caseId}]`);

      if (this.uploadAttachments && testResult.attachments.length > 0)
        await this._uploadAttachmentsFunc(testResult, testCaseResult.result.value![0].id, caseId);

      this._removePublished(testAlias);
      this.publishedResultsCount++;
      this._log(chalk.gray(`Result published: ${test.title}`));
      return testCaseResult;
    } catch (error: any) {
      this._removePublished(testAlias);
      this._warning(chalk.red(error.message));
    }
  }
}

export default AzureDevOpsReporter;
