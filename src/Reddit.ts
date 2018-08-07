import get from 'lodash.get';
import merge from 'lodash.merge';
import pick from 'lodash.pick';
import nanoid from 'nanoid';
import { AuthOptions, Headers } from 'request';
import request from 'request-promise-native';
import RateLimit from './RateLimit';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

type Scope =
  | 'account'
  | 'creddits'
  | 'edit'
  | 'flair'
  | 'history'
  | 'identity'
  | 'livemanage'
  | 'modconfig'
  | 'modcontributors'
  | 'modflair'
  | 'modlog'
  | 'modmail'
  | 'modothers'
  | 'modposts'
  | 'modself'
  | 'modtraffic'
  | 'modwiki'
  | 'mysubreddits'
  | 'privatemessages'
  | 'read'
  | 'report'
  | 'save'
  | 'structuredstyles'
  | 'submit'
  | 'subscribe'
  | 'vote'
  | 'wikiedit'
  | 'wikiread';

interface RequestOptions {
  [key: string]: unknown;
  domain?: string;
  uri?: string;
  method?: Method;
  headers?: Headers;
  auth?: AuthOptions;
  form?: { [key: string]: unknown };
}

/**
 * Wrapper for Reddit's API, providing minimal functionality.
 * Additional endpoints, if necessary, should not be difficult to implement.
 */
export default class Reddit {
  /**
   * Rate limit all requests to the specified amount.
   * Burst requests are not available — they are fired upon even intervals.
   */
  private static queue = new RateLimit('60 per minute');

  /**
   * Map of pending authentication states to `NodeJS.Timer` objects.
   * The latter deletes itself and the key after one hour,
   * preventing unauthorized states from being passed.
   */
  private static pending_auth_states: { [key: string]: NodeJS.Timer } = {};

  /**
   * The refresh token used to get a new bearer token.
   * This should be located in persistent storage,
   * and passed to `auth()` as the only parameter to fetch a new bearer token.
   */
  public get refresh_token() {
    return this._refresh_token;
  }
  private _refresh_token: Option<string>;

  /**
   * The current token used to authenticate with Reddit.
   * Replaced upon expiration; never in persistent storage.
   */
  private bearer_token: Option<string>;

  /**
   * The object from `setTimeout`, set to trigger one minute before token expiration.
   * _Do not modify this variable directly._
   * It should only be set using the response from an API request.
   */
  private refresh_token_timeout: NodeJS.Timer;

  /**
   * @param user_agent The user agent to send in the header of each request.
   *   You should include your app's _name_, _version_, and _your username_.
   * @param client_id The client ID provided by Reddit, located directly under
   *   'web app' on [this page](https://www.reddit.com/prefs/apps/).
   * @param secret The app's secret provided by Reddit, visible after clicking
   *   'edit' on [this page](https://www.reddit.com/prefs/apps/).
   * @param redirect_uri The URI to redirect to after authentication (successful
   *   or failed). This must _exactly_ match the URI located in [your app
   *   configuration](https://www.reddit.com/prefs/apps/).
   * @param scopes An array of scopes to be requested. If using TypeScript, the
   *   available scopes are checked at compile time.
   * @param permanent Do you want permanent access to this account (`true`), or
   *   will you ask again in an hour (`false`)? Defaults to permanent.
   */
  constructor(
    private readonly user_agent: string,
    private readonly client_id: string,
    private readonly secret: string,
    private readonly redirect_uri: string,
    private readonly scopes: ReadonlyArray<Scope>,
    private readonly permanent = true,
  ) {}

  // BEGIN ENDPOINTS

  /**
   * Returns the identity of the user.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#GET_api_v1_me)
   */
  public me(): Promise<any> {
    return this.api_request('/api/v1/me');
  }

  /**
   * Return the preference settings of the logged in user.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#GET_api_v1_me_prefs)
   */
  public prefs(): Promise<any> {
    return this.api_request('/api/v1/me/prefs');
  }

  /**
   * Submit will create a self-post in the provided subreddit with the provided title.
   * `text`, if present, will be the body of the post unless `richtext_json` is present,
   * in which case it will be converted into the body of the post.
   * An error is thrown if both `text` and `richtext_json` are present.
   *
   * [Reddit documentation](https://www.reddit.com/dev/api/oauth#POST_api_submit)
   *
   * @param subreddit Which subreddit to submit the post to.
   * @param title The title of the post.
   * @param text The text (body) of the post.
   * @param options (all optional) Flair ID, flair text, NSFW, send replies to inbox
   */
  public submit_text_post(
    subreddit: string,
    title: string,
    text: string,
    options?: {
      flair_id?: string;
      flair_text?: string;
      nsfw?: boolean;
      sendreplies?: boolean;
    },
  ): Promise<any> {
    return this.api_request('/api/submit', {
      method: 'POST',
      kind: 'self',
      api_type: 'json',
      extension: 'json',
      sendreplies: false,
      sr: subreddit,
      text,
      title,
      ...options,
    });
  }

  // END ENDPOINTS

  /**
   * Clear all information specific to the authenticated user.
   */
  public logout(): void {
    if (this.refresh_token_timeout) {
      clearTimeout(this.refresh_token_timeout);
    }

    this.bearer_token = undefined;
    this._refresh_token = undefined;
  }

  /**
   * The URI to send the end user to.
   * Includes a unique state, the list of scopes, and duration.
   *
   * Important note: This value changes upon every request.
   */
  public get auth_url(): string {
    const state = nanoid();

    // we only want to allow states that we have knowledge of.
    // must be fulfulled within one hour or it is rejected
    Reddit.pending_auth_states[state] = setTimeout(
      () => delete Reddit.pending_auth_states[state],
      3_600,
    );

    return (
      `https://ssl.reddit.com/api/v1/authorize` +
      `?client_id=${this.client_id}` +
      `&response_type=code` +
      `&state=${state}` +
      `&redirect_uri=${encodeURIComponent(this.redirect_uri)}` +
      `&duration=${this.permanent ? 'permanent' : 'temporary'}` +
      `&scope=${this.scopes.join(',')}`
    );
  }

  /**
   * @param refresh_token The refresh token to create a session from. Likely in
   *   persistent storage.
   */
  public async auth(refresh_token: string): Promise<any>;
  /**
   * @param options.state The unique state variable in the response. It is not
   *   necessary to check the accuracy of this variable — it is performed
   *   automatically.
   * @param options.code The code variable returned in the response.
   */
  // tslint:disable-next-line unified-signatures
  public async auth(options: { state: string; code: string }): Promise<any>;
  public async auth(
    options: string | { state: string; code: string },
  ): Promise<any> {
    let form;

    // we've been passed a refresh token,
    // _not_ a state and code for first-time authentication
    if (typeof options === 'string') {
      form = {
        grant_type: 'refresh_token',
        refresh_token: (this._refresh_token = options),
      };
    }
    // new authorization, no refresh token
    else {
      // require a state that is pending. if one is not found, reject.
      if (Reddit.pending_auth_states.hasOwnProperty(options.state)) {
        clearTimeout(Reddit.pending_auth_states[options.state]);
        delete Reddit.pending_auth_states[options.state];
      } else {
        return Promise.reject('State not found.');
      }

      form = {
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: this.redirect_uri,
      };
    }

    // perform the request
    // if we have a refresh token and the request fails, automatically retry
    let json;
    try {
      json = await this.api_request('/api/v1/access_token', {
        domain: 'https://ssl.reddit.com',
        method: 'POST',
        form,
        in_authorization_flow: true,
      });
    } catch (err) {
      // refresh token, not new authorization
      if (typeof options === 'string') {
        if (err === 'invalid_request') {
          // token is no longer valid, let's log out
          return this.logout();
        } else {
          // some other error, try again
          this.auth(options);
        }
      }

      throw err;
    }

    // set instance variables from response
    this.bearer_token = json.access_token;
    if (json.refresh_token !== undefined) {
      this._refresh_token = json.refresh_token;
    }

    // let's refresh the token a minute before it expires
    if (this._refresh_token !== undefined && json.expires_in !== undefined) {
      this.refresh_token_timeout = setTimeout(
        () => this.auth(this._refresh_token!),
        json.expires_in * 1_000 - 60_000,
      );
    }

    return json;
  }

  /**
   * @param endpoint The full endpoint, including the leading slash. This will
   *   exactly match the path located on [this page](https://www.reddit.com/dev/api).
   * @param parse_options Any options used when parsing the response. Currently
   *   only the key `json`, which will automatically run the body through
   *   `JSON.parse` if `true`.
   * @param _req_options Any options passed onto the request. Will be merged
   *   with defaults.
   */
  private async api_request(
    endpoint: string,
    _req_options: RequestOptions = {},
    parse_options: { json?: boolean } = { json: true },
  ): Promise<any> {
    const req_options: RequestOptions = merge(
      {
        domain: 'https://oauth.reddit.com',
        method: 'GET',
        headers: {
          'User-Agent': this.user_agent,
        },
      },
      this.bearer_token === undefined
        ? {}
        : { headers: { Authorization: `bearer ${this.bearer_token}` } },
      _req_options,
    );

    // automatically add authentication where necessary
    if (
      req_options.domain !== 'https://www.reddit.com' &&
      !req_options.domain!.startsWith('https://oauth.reddit.com')
    ) {
      req_options.auth = { user: this.client_id, pass: this.secret };
    }

    // this is all we need to do to properly rate limit all requests
    await new Promise(resolve => Reddit.queue.push(resolve));

    // make the request using the appropriate options
    let json = await request({
      uri: `${req_options.domain}${endpoint}`,
      ...pick(req_options, ['method', 'form', 'qs', 'headers', 'auth']),
    });

    // parse the JSON if requested, throwing errors as appropriate
    if (parse_options.json) {
      json = JSON.parse(json);

      if (get(json, 'error')) {
        throw json.error;
      }
      if (get(json, 'json.errors')) {
        throw json.json.errors;
      }
    }
    return json;
  }
}
