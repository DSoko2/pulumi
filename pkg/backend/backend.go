// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package backend

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pulumi/pulumi/pkg/v3/backend/display"
	"github.com/pulumi/pulumi/pkg/v3/engine"
	"github.com/pulumi/pulumi/pkg/v3/operations"
	"github.com/pulumi/pulumi/pkg/v3/resource/deploy"
	"github.com/pulumi/pulumi/pkg/v3/resource/stack"
	"github.com/pulumi/pulumi/pkg/v3/secrets"
	"github.com/pulumi/pulumi/pkg/v3/util/cancel"
	"github.com/pulumi/pulumi/sdk/v3/go/common/apitype"
	"github.com/pulumi/pulumi/sdk/v3/go/common/diag"
	sdkDisplay "github.com/pulumi/pulumi/sdk/v3/go/common/display"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource"
	"github.com/pulumi/pulumi/sdk/v3/go/common/resource/config"
	"github.com/pulumi/pulumi/sdk/v3/go/common/tokens"
	"github.com/pulumi/pulumi/sdk/v3/go/common/util/result"
	"github.com/pulumi/pulumi/sdk/v3/go/common/workspace"
)

// ErrNoPreviousDeployment is returned when there isn't a previous deployment.
var ErrNoPreviousDeployment = errors.New("no previous deployment")

// StackAlreadyExistsError is returned from CreateStack when the stack already exists in the backend.
type StackAlreadyExistsError struct {
	StackName string
}

func (e StackAlreadyExistsError) Error() string {
	return fmt.Sprintf("stack '%v' already exists", e.StackName)
}

// OverStackLimitError is returned from CreateStack when the organization is billed per-stack and
// is over its stack limit.
type OverStackLimitError struct {
	Message string
}

func (e OverStackLimitError) Error() string {
	m := e.Message
	m = strings.ReplaceAll(m, "Conflict: ", "over stack limit: ")
	return m
}

// StackReference is an opaque type that refers to a stack managed by a backend.  The CLI uses the ParseStackReference
// method to turn a string like "my-great-stack" or "pulumi/my-great-stack" into a stack reference that can be used to
// interact with the stack via the backend. Stack references are specific to a given backend and different back ends
// may interpret the string passed to ParseStackReference differently.
type StackReference interface {
	// fmt.Stringer's String() method returns a string of the stack identity, suitable for display in the CLI
	fmt.Stringer
	// Name is the name that will be passed to the Pulumi engine when preforming operations on this stack. This
	// name may not uniquely identify the stack (e.g. the cloud backend embeds owner information in the StackReference
	// but that information is not part of the StackName() we pass to the engine.
	Name() tokens.Name

	// Fully qualified name of the stack, including any organization, project, or other information.
	FullyQualifiedName() tokens.QName
}

// PolicyPackReference is an opaque type that refers to a PolicyPack managed by a backend. The CLI
// uses the ParsePolicyPackReference method to turn a string like "myOrg/mySecurityRules" into a
// PolicyPackReference that can be used to interact with the PolicyPack via the backend.
// PolicyPackReferences are specific to a given backend and different back ends may interpret the
// string passed to ParsePolicyPackReference differently.
type PolicyPackReference interface {
	// fmt.Stringer's String() method returns a string of the stack identity, suitable for display in the CLI
	fmt.Stringer
	// OrgName is the name of the organization that is managing the PolicyPack.
	OrgName() string
	// Name is the name of the PolicyPack being referenced.
	Name() tokens.QName
}

// StackSummary provides a basic description of a stack, without the ability to inspect its resources or make changes.
type StackSummary interface {
	Name() StackReference

	// LastUpdate returns when the stack was last updated, as applicable.
	LastUpdate() *time.Time
	// ResourceCount returns the stack's resource count, as applicable.
	ResourceCount() *int
}

// ListStacksFilter describes optional filters when listing stacks.
type ListStacksFilter struct {
	Organization *string
	Project      *string
	TagName      *string
	TagValue     *string
}

// ContinuationToken is an opaque string used for paginated backend requests. If non-nil, means
// there are more results to be returned and the continuation token should be passed into a
// subsequent call to the backend method. A nil continuation token means all results have been
// returned.
type ContinuationToken *string

// Backend is the contract between the Pulumi engine and pluggable backend implementations of the Pulumi Cloud Service.
type Backend interface {
	// Name returns a friendly name for this backend.
	Name() string
	// URL returns a URL at which information about this backend may be seen.
	URL() string

	// SetCurrentProject sets the current ambient project for this backend.
	SetCurrentProject(proj *workspace.Project)

	// GetPolicyPack returns a PolicyPack object tied to this backend, or nil if it cannot be found.
	GetPolicyPack(ctx context.Context, policyPack string, d diag.Sink) (PolicyPack, error)

	// ListPolicyGroups returns all Policy Groups for an organization in this backend or an error if it cannot be found.
	ListPolicyGroups(ctx context.Context, orgName string, inContToken ContinuationToken) (
		apitype.ListPolicyGroupsResponse, ContinuationToken, error)

	// ListPolicyPacks returns all Policy Packs for an organization in this backend, or an error if it cannot be found.
	ListPolicyPacks(ctx context.Context, orgName string, inContToken ContinuationToken) (
		apitype.ListPolicyPacksResponse, ContinuationToken, error)

	// SupportsTags tells whether a stack can have associated tags stored with it in this backend.
	SupportsTags() bool

	// SupportsOrganizations tells whether a user can belong to multiple organizations in this backend.
	SupportsOrganizations() bool

	// ParseStackReference takes a string representation and parses it to a reference which may be used for other
	// methods in this backend.
	ParseStackReference(s string) (StackReference, error)
	// ValidateStackName verifies that the string is a legal identifier for a (potentially qualified) stack.
	// Will check for any backend-specific naming restrictions.
	ValidateStackName(s string) error

	// DoesProjectExist returns true if a project with the given name exists in this backend, or false otherwise.
	DoesProjectExist(ctx context.Context, projectName string) (bool, error)

	// GetStack returns a stack object tied to this backend with the given name, or nil if it cannot be found.
	GetStack(ctx context.Context, stackRef StackReference) (Stack, error)
	// CreateStack creates a new stack with the given name and options that are specific to the backend provider.
	CreateStack(ctx context.Context, stackRef StackReference, root string, opts *CreateStackOptions) (Stack, error)

	// RemoveStack removes a stack with the given name.  If force is true, the stack will be removed even if it
	// still contains resources.  Otherwise, if the stack contains resources, a non-nil error is returned, and the
	// first boolean return value will be set to true.
	RemoveStack(ctx context.Context, stack Stack, force bool) (bool, error)
	// ListStacks returns a list of stack summaries for all known stacks in the target backend.
	ListStacks(ctx context.Context, filter ListStacksFilter, inContToken ContinuationToken) (
		[]StackSummary, ContinuationToken, error)

	// RenameStack renames the given stack to a new name, and then returns an updated stack reference that
	// can be used to refer to the newly renamed stack.
	RenameStack(ctx context.Context, stack Stack, newName tokens.QName) (StackReference, error)

	// Preview shows what would be updated given the current workspace's contents.
	Preview(ctx context.Context, stack Stack, op UpdateOperation) (*deploy.Plan, sdkDisplay.ResourceChanges, result.Result)
	// Update updates the target stack with the current workspace's contents (config and code).
	Update(ctx context.Context, stack Stack, op UpdateOperation) (sdkDisplay.ResourceChanges, result.Result)
	// Import imports resources into a stack.
	Import(ctx context.Context, stack Stack, op UpdateOperation,
		imports []deploy.Import) (sdkDisplay.ResourceChanges, result.Result)
	// Refresh refreshes the stack's state from the cloud provider.
	Refresh(ctx context.Context, stack Stack, op UpdateOperation) (sdkDisplay.ResourceChanges, result.Result)
	// Destroy destroys all of this stack's resources.
	Destroy(ctx context.Context, stack Stack, op UpdateOperation) (sdkDisplay.ResourceChanges, result.Result)
	// Watch watches the project's working directory for changes and automatically updates the active stack.
	Watch(ctx context.Context, stack Stack, op UpdateOperation, paths []string) result.Result

	// Query against the resource outputs in a stack's state checkpoint.
	Query(ctx context.Context, op QueryOperation) result.Result

	// GetHistory returns all updates for the stack. The returned UpdateInfo slice will be in
	// descending order (newest first).
	GetHistory(ctx context.Context, stackRef StackReference, pageSize int, page int) ([]UpdateInfo, error)
	// GetLogs fetches a list of log entries for the given stack, with optional filtering/querying.
	GetLogs(ctx context.Context, secretsProvider secrets.Provider, stack Stack, cfg StackConfiguration,
		query operations.LogQuery) ([]operations.LogEntry, error)
	// Get the configuration from the most recent deployment of the stack.
	GetLatestConfiguration(ctx context.Context, stack Stack) (config.Map, error)

	// UpdateStackTags updates the stacks's tags, replacing all existing tags.
	UpdateStackTags(ctx context.Context, stack Stack, tags map[apitype.StackTagName]string) error

	// ExportDeployment exports the deployment for the given stack as an opaque JSON message.
	ExportDeployment(ctx context.Context, stack Stack) (*apitype.UntypedDeployment, error)
	// ImportDeployment imports the given deployment into the indicated stack.
	ImportDeployment(ctx context.Context, stack Stack, deployment *apitype.UntypedDeployment) error
	// Logout logs you out of the backend and removes any stored credentials.
	Logout() error
	// LogoutAll logs you out of all the backend and removes any stored credentials.
	LogoutAll() error
	// Returns the identity of the current user and any organizations they are in for the backend.
	CurrentUser() (string, []string, error)

	// Cancel the current update for the given stack.
	CancelCurrentUpdate(ctx context.Context, stackRef StackReference) error
}

// SpecificDeploymentExporter is an interface defining an additional capability of a Backend, specifically the
// ability to export a specific versions of a stack's deployment. This isn't a requirement for all backends and
// should be checked for dynamically.
type SpecificDeploymentExporter interface {
	// ExportDeploymentForVersion exports a specific deployment from the history of a stack. The meaning of
	// version is backend-specific. For the Pulumi Console, it is the numeric version. (The first update
	// being version "1", the second "2", and so on.) Though this might change in the future to use some
	// other type of identifier or commitish .
	ExportDeploymentForVersion(ctx context.Context, stack Stack, version string) (*apitype.UntypedDeployment, error)
}

// UpdateOperation is a complete stack update operation (preview, update, import, refresh, or destroy).
type UpdateOperation struct {
	Proj               *workspace.Project
	Root               string
	Imports            []deploy.Import
	M                  *UpdateMetadata
	Opts               UpdateOptions
	SecretsManager     secrets.Manager
	SecretsProvider    secrets.Provider
	StackConfiguration StackConfiguration
	Scopes             CancellationScopeSource
}

// QueryOperation configures a query operation.
type QueryOperation struct {
	Proj               *workspace.Project
	Root               string
	Opts               UpdateOptions
	SecretsManager     secrets.Manager
	SecretsProvider    secrets.Provider
	StackConfiguration StackConfiguration
	Scopes             CancellationScopeSource
}

// StackConfiguration holds the configuration for a stack and it's associated decrypter.
type StackConfiguration struct {
	Config    config.Map
	Decrypter config.Decrypter
}

// UpdateOptions is the full set of update options, including backend and engine options.
type UpdateOptions struct {
	// Engine contains all of the engine-specific options.
	Engine engine.UpdateOptions
	// Display contains all of the backend display options.
	Display display.Options

	// AutoApprove, when true, will automatically approve previews.
	AutoApprove bool
	// SkipPreview, when true, causes the preview step to be skipped.
	SkipPreview bool
}

// QueryOptions configures a query to operate against a backend and the engine.
type QueryOptions struct {
	// Engine contains all of the engine-specific options.
	Engine engine.UpdateOptions
	// Display contains all of the backend display options.
	Display display.Options
}

// CancellationScope provides a scoped source of cancellation and termination requests.
type CancellationScope interface {
	// Context returns the cancellation context used to observe cancellation and termination requests for this scope.
	Context() *cancel.Context
	// Close closes the cancellation scope.
	Close()
}

// CancellationScopeSource provides a source for cancellation scopes.
type CancellationScopeSource interface {
	// NewScope creates a new cancellation scope.
	NewScope(events chan<- engine.Event, isPreview bool) CancellationScope
}

// NewBackendClient returns a deploy.BackendClient that wraps the given Backend.
func NewBackendClient(backend Backend, secretsProvider secrets.Provider) deploy.BackendClient {
	return &backendClient{backend: backend, secretsProvider: secretsProvider}
}

type backendClient struct {
	backend         Backend
	secretsProvider secrets.Provider
}

// GetStackOutputs returns the outputs of the stack with the given name.
func (c *backendClient) GetStackOutputs(ctx context.Context, name string) (resource.PropertyMap, error) {
	ref, err := c.backend.ParseStackReference(name)
	if err != nil {
		return nil, err
	}
	s, err := c.backend.GetStack(ctx, ref)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, fmt.Errorf("unknown stack %q", name)
	}
	snap, err := s.Snapshot(ctx, c.secretsProvider)
	if err != nil {
		return nil, err
	}
	res, err := stack.GetRootStackResource(snap)
	if err != nil {
		return nil, fmt.Errorf("getting root stack resources: %w", err)
	}
	if res == nil {
		return resource.PropertyMap{}, nil
	}
	return res.Outputs, nil
}

func (c *backendClient) GetStackResourceOutputs(
	ctx context.Context, name string,
) (resource.PropertyMap, error) {
	ref, err := c.backend.ParseStackReference(name)
	if err != nil {
		return nil, err
	}
	s, err := c.backend.GetStack(ctx, ref)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return nil, fmt.Errorf("unknown stack %q", name)
	}
	snap, err := s.Snapshot(ctx, c.secretsProvider)
	if err != nil {
		return nil, err
	}
	pm := resource.PropertyMap{}
	for _, r := range snap.Resources {
		if r.Delete {
			continue
		}

		resc := resource.PropertyMap{
			resource.PropertyKey("type"):    resource.NewStringProperty(string(r.Type)),
			resource.PropertyKey("outputs"): resource.NewObjectProperty(r.Outputs),
		}
		pm[resource.PropertyKey(r.URN)] = resource.NewObjectProperty(resc)
	}
	return pm, nil
}

// ErrTeamsNotSupported is returned by backends
// which do not support the teams feature.
var ErrTeamsNotSupported = errors.New("teams are not supported")

// CreateStackOptions provides options for stack creation.
// At present, options only apply to the Service.
type CreateStackOptions struct {
	// Teams is a list of teams who should have access to
	// the newly created stack.
	// This option is only appropriate for backends
	// which support teams (i.e. the Pulumi Service).
	//
	// The backend may return ErrTeamsNotSupported
	// if Teams is specified but not supported.
	Teams []string
}
